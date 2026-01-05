/**
 * Firestore Trigger: Members Cache
 * 
 * Aktualisiert automatisch ein Cache-Dokument mit allen Mitgliedern einer Association,
 * wenn sich Mitglieder in der members Collection ändern.
 */

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { getFirestore } from '../../shared/firestore-instance';

const db = getFirestore();

/**
 * Lädt alle Mitglieder einer Association, kombiniert sie mit User-Daten und speichert sie im Cache
 */
async function updateMembersCache(associationId: string): Promise<void> {
  try {
    const membersCollection = db.collection('associations').doc(associationId).collection('members');
    const membersSnapshot = await membersCollection.orderBy('joinedAt', 'desc').get();
    
    const members = [];
    for (const memberDoc of membersSnapshot.docs) {
      const memberData = memberDoc.data();
      const userId = memberData.userId || memberDoc.id;
      
      // Lade User-Daten
      let userData: any = {};
      try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
          userData = userDoc.data() || {};
        }
      } catch (userError) {
        functions.logger.warn(`⚠️ Fehler beim Laden der User-Daten für ${userId}:`, userError);
      }
      
      // Kombiniere Member- und User-Daten (wie in mapMembersFromSnapshot)
      const firstName = memberData.firstName || (userData as any).firstName || '';
      const lastName = memberData.lastName || (userData as any).lastName || '';
      const street = memberData.street || (userData as any).street || '';
      const houseNumber = memberData.houseNumber || (userData as any).houseNumber || '';
      const city = memberData.city || (userData as any).city || '';
      const postalCode = memberData.postalCode || (userData as any).postalCode || '';
      const country = memberData.country || (userData as any).country || 'Deutschland';
      const salutation = memberData.salutation || (userData as any).salutation || '';
      const email = memberData.email || (userData as any).email || '';
      const birthDate = memberData.birthDate || (userData as any).birthDate;
      
      // Konvertiere Timestamps zu ISO-Strings für JSON-Serialisierung
      const processedMember = {
        id: userId,
        userId: userId,
        ...memberData,
        ...userData,
        // Überschreibe mit kombinierten Werten
        firstName,
        lastName,
        street,
        houseNumber,
        city,
        postalCode,
        country,
        salutation,
        email,
        // Timestamps konvertieren
        joinedAt: memberData.joinedAt?.toDate ? memberData.joinedAt.toDate().toISOString() : (typeof memberData.joinedAt === 'string' ? memberData.joinedAt : null),
        lastActivity: memberData.lastActivity?.toDate ? memberData.lastActivity.toDate().toISOString() : (typeof memberData.lastActivity === 'string' ? memberData.lastActivity : null),
        birthDate: birthDate?.toDate ? birthDate.toDate().toISOString() : (typeof birthDate === 'string' ? birthDate : birthDate),
      };
      members.push(processedMember);
    }
    
    // Speichere im Cache-Dokument
    const cacheRef = db.collection('associations').doc(associationId).collection('cache').doc('members');
    await cacheRef.set({
      members,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      count: members.length,
    }, { merge: false });
    
    functions.logger.info(`✅ Members Cache aktualisiert für Association ${associationId}: ${members.length} Mitglieder`);
  } catch (error) {
    functions.logger.error(`❌ Fehler beim Aktualisieren des Members Cache für Association ${associationId}:`, error);
    throw error;
  }
}

/**
 * Firestore Trigger: Wird ausgelöst, wenn ein Mitglied in der members Collection erstellt, aktualisiert oder gelöscht wird
 */
export const onMemberChanged = functions
  .region('europe-west1')
  .firestore
  .document('associations/{associationId}/members/{memberId}')
  .onWrite(async (change, context) => {
    const associationId = context.params.associationId;
    
    functions.logger.info(`🔄 Member geändert in Association ${associationId}, aktualisiere Cache...`);
    
    try {
      await updateMembersCache(associationId);
    } catch (error) {
      functions.logger.error(`❌ Fehler beim Aktualisieren des Cache nach Member-Änderung:`, error);
      // Wir werfen den Fehler nicht, damit die Function nicht fehlschlägt
      // Der Cache wird beim nächsten Aufruf aktualisiert
    }
  });

/**
 * Callable Function: Manuelles Aktualisieren des Cache (für Initialisierung oder manuelle Aktualisierung)
 */
export const refreshMembersCache = functions
  .region('europe-west1')
  .https
  .onCall(async (data, context) => {
    // Authentifizierung prüfen
    if (!context.auth) {
      throw new functions.https.HttpsError(
        'unauthenticated',
        'Die Function muss authentifiziert aufgerufen werden.'
      );
    }
    
    const { associationId } = data;
    if (!associationId) {
      throw new functions.https.HttpsError(
        'invalid-argument',
        'associationId ist erforderlich'
      );
    }
    
    try {
      await updateMembersCache(associationId);
      return { success: true, message: 'Cache erfolgreich aktualisiert' };
    } catch (error) {
      functions.logger.error('❌ Fehler beim manuellen Aktualisieren des Cache:', error);
      throw new functions.https.HttpsError(
        'internal',
        'Fehler beim Aktualisieren des Cache'
      );
    }
  });

