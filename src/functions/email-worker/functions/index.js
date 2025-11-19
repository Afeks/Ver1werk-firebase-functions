const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const EMAIL_QUEUE_COLLECTION = 'emailQueue';
const ASSOCIATIONS_COLLECTION = 'associations';
const MAX_ATTEMPTS = 5;

const loadAssociationEmailSettings = async (associationId) => {
  if (!associationId) {
    throw new Error('Association ID fehlt.');
  }
  const snap = await db.collection(ASSOCIATIONS_COLLECTION).doc(associationId).get();
  if (!snap.exists) {
    throw new Error(`Association ${associationId} nicht gefunden.`);
  }
  const data = snap.data();
  const settings = data.emailSettings || {};
  const required = ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'senderEmail'];
  for (const key of required) {
    if (!settings[key]) {
      throw new Error(`SMTP-Einstellung "${key}" fehlt für Association ${associationId}.`);
    }
  }
  return {
    smtpHost: settings.smtpHost,
    smtpPort: Number(settings.smtpPort) || 587,
    smtpUser: settings.smtpUser,
    smtpPassword: settings.smtpPassword,
    useTLS: settings.useTLS !== false,
    senderName: settings.senderName || data.name || 'Ticketing',
    senderEmail: settings.senderEmail,
    replyTo: settings.replyTo || null
  };
};

const buildTransporter = (config) => {
  const isSecure = config.smtpPort === 465 && config.useTLS !== false;
  const transportOptions = {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: isSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPassword
    }
  };
  if (config.useTLS && !isSecure) {
    transportOptions.requireTLS = true;
  }
  return nodemailer.createTransport(transportOptions);
};

const sendEmail = async ({ transporter, fromName, fromEmail, to, subject, body, replyTo }) => {
  const mailOptions = {
    from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    to,
    subject,
    text: body,
    html: body.includes('<') ? body : undefined
  };

  if (replyTo) {
    mailOptions.replyTo = replyTo;
  }

  await transporter.sendMail(mailOptions);
};

const markAsFailed = async (docRef, error, attempts) => {
  const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'error';
  await docRef.update({
    status,
    lastError: error.message || String(error),
    lockedAt: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  });
};

const handleEmailDocument = async (docRef) => {
  let emailData;
  let currentAttempts = 0;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) {
      throw new Error('Dokument existiert nicht mehr.');
    }
    const data = snap.data();
    const status = data.status || 'pending';

    if (status === 'sent') {
      throw new Error('Bereits versendet.');
    }
    if (status === 'processing') {
      throw new Error('Wird bereits verarbeitet.');
    }

    emailData = data;
    currentAttempts = (data.attempts || 0) + 1;

    tx.update(docRef, {
      status: 'processing',
      attempts: FieldValue.increment(1),
      lockedAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  try {
    const associationConfig = await loadAssociationEmailSettings(emailData.associationId);
    const transporter = buildTransporter(associationConfig);

    if (!emailData.to || !emailData.subject || !emailData.body) {
      throw new Error('E-Mail-Daten unvollständig (to/subject/body).');
    }

    await sendEmail({
      transporter,
      fromName: associationConfig.senderName,
      fromEmail: associationConfig.senderEmail,
      to: emailData.to,
      subject: emailData.subject,
      body: emailData.body,
      replyTo: emailData.replyTo || associationConfig.replyTo
    });

    await docRef.update({
      status: 'sent',
      sentAt: FieldValue.serverTimestamp(),
      lockedAt: FieldValue.delete(),
      lastError: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
    functions.logger.info('E-Mail erfolgreich versendet', {
      docId: docRef.id,
      to: emailData.to
    });
  } catch (error) {
    functions.logger.error('Fehler beim E-Mail-Versand', {
      docId: docRef.id,
      error: error.message
    });
    await markAsFailed(docRef, error, currentAttempts);
  }
};

exports.onEmailQueued = functions.firestore
  .document(`${EMAIL_QUEUE_COLLECTION}/{emailId}`)
  .onCreate(async (snap) => {
    try {
      await handleEmailDocument(snap.ref);
    } catch (err) {
      // Fehler wurden bereits geloggt / markiert
      functions.logger.warn('E-Mail konnte nicht sofort verarbeitet werden', {
        docId: snap.id,
        error: err.message
      });
    }
  });

exports.processEmailQueue = functions.pubsub
  .schedule('every 5 minutes')
  .timeZone('Europe/Berlin')
  .onRun(async () => {
    const batch = await db
      .collection(EMAIL_QUEUE_COLLECTION)
      .where('status', 'in', ['pending', 'error'])
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();

    if (batch.empty) {
      functions.logger.info('Keine offenen E-Mail-Aufträge gefunden.');
      return null;
    }

    for (const doc of batch.docs) {
      try {
        await handleEmailDocument(doc.ref);
      } catch (err) {
        functions.logger.warn('Batch-Versand fehlgeschlagen', {
          docId: doc.id,
          error: err.message
        });
      }
    }

    return null;
  });

