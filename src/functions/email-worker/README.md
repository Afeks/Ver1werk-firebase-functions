# Email Queue Worker (Cloud Functions)

Dieses Verzeichnis enthält eine eigenständige Firebase-Functions-Codebasis, die
E-Mail-Aufträge aus der `emailQueue`-Collection verarbeitet und über SMTP
verschickt. Du kannst den Ordner in dein separates Repository kopieren oder als
Vorlage verwenden.

## Features

- Firestore-Trigger auf `emailQueue/{emailId}` (neue Dokumente werden sofort verarbeitet)
- Geplanter Fallback (Pub/Sub CRON), der hängen gebliebene Jobs regelmäßig prüft
- SMTP-Versand via Nodemailer basierend auf den Einstellungen unter
  `associations/{associationId}.emailSettings`
- Status-Updates auf dem Queue-Dokument (`pending` → `sent` / `failed`)

## Projektstruktur

```
email-worker/
├─ functions/
│  ├─ index.js           # Cloud Functions (Trigger + Helper)
│  ├─ package.json       # Functions-Abhängigkeiten
├─ .gitignore            # Ignoriert node_modules etc.
└─ README.md             # (dieses Dokument)
```

## Voraussetzungen

- Firebase CLI installiert (`npm i -g firebase-tools`)
- Service-Account/Projekt mit Firestore
- In `associations/{associationId}` existiert ein Feld `emailSettings` mit:

  ```jsonc
  {
    "smtpHost": "mail.example.com",
    "smtpPort": 587,
    "smtpUser": "username",
    "smtpPassword": "app-password",
    "useTLS": true,
    "senderName": "Musikverein",
    "senderEmail": "tickets@verein.de",
    "replyTo": "support@verein.de"
  }
  ```

## Deployment / Verwendung

1. **Firebase Functions initialisieren** (falls neues Repo):

   ```bash
   cd email-worker
   firebase init functions
   ```

   > Falls du bereits ein Functions-Projekt hast, kopiere nur den Inhalt von
   > `functions/` in dein bestehendes Projekt.

2. **Abhängigkeiten installieren:**

   ```bash
   cd functions
   npm install
   ```

3. **(Optional) Lokales Testing:**

   ```bash
   firebase emulators:start --only functions,firestore
   ```

4. **Deploy:**

   ```bash
   firebase deploy --only functions:processEmailQueue,functions:onEmailQueued
   ```

## Erweiterungen / Anpassungen

- **Retry-Strategie:** Standardmäßig werden Fehlversuche in `attempts` gezählt.
  Du kannst z. B. nach 5 Versuchen endgültig abbrechen.
- **Anhänge:** Wenn du PDFs oder Tickets anhängen möchtest, erweitere
  `buildTransporter` / `sendEmail` um `attachments`.
- **Template-Engine:** Derzeit erwartet der Worker, dass `subject`/`body`
  bereits vom Backend ersetzt wurden (z. B. `buildTicketEmailContent`). Du
  kannst dies optional in den Worker verlagern.

## Hinweise

- Halte SMTP-Passwörter als App-Passwörter bereit (z. B. Gmail App Passwords).
- Das Queue-Dokument wird auf `status: "sent"` gesetzt, sobald Nodemailer den
  Versand bestätigt. Bei Fehlern wird `status: "failed"` + `lastError`
  gespeichert.
- Du kannst den Cron-Intervall (`every 5 minutes`) in `processEmailQueue`
  anpassen oder nur den Firestore-Trigger verwenden, wenn du sofortige
  Ausführung bevorzugst.

Viel Erfolg beim Einbinden!

