# Firebase Functions Deployment - Development & Production

## Übersicht

Die Firebase Functions werden basierend auf dem Git Branch deployed:

- **`master` oder `main` Branch** → Deployed zu **Production Firebase** (`ver1werk`)
- **`development` Branch** → Deployed zu **Development Firebase** (`ver1werk-dev`)

## Konfiguration

### Firebase Projekte

Die Projekte sind in `.firebaserc` definiert:

```json
{
  "projects": {
    "default": "ver1werk",
    "production": "ver1werk",
    "development": "ver1werk-dev"
  }
}
```

### GitHub Actions Workflow

Der Workflow (`.github/workflows/deploy.yml`) hat zwei Jobs:

1. **`deploy-production`**: Wird ausgelöst bei Push auf `master` oder `main`
2. **`deploy-development`**: Wird ausgelöst bei Push auf `development`

## GitHub Secrets

Du musst folgende Secrets in GitHub setzen:

### Production Deployment

- **`FIREBASE_TOKEN`** (erforderlich)
  - Firebase CI Token für das Production-Projekt (`ver1werk`)
  - Generiere mit: `firebase login:ci` (für Production-Projekt)

### Development Deployment

Du hast zwei Optionen:

#### Option 1: Gleiches Token verwenden (einfacher)

- Verwende einfach das gleiche `FIREBASE_TOKEN` Secret
- Der Workflow verwendet automatisch `FIREBASE_TOKEN` als Fallback

#### Option 2: Separates Token (empfohlen für Sicherheit)

- **`FIREBASE_TOKEN_DEV`** (optional)
  - Firebase CI Token für das Development-Projekt (`ver1werk-dev`)
  - Generiere mit: `firebase login:ci` (für Development-Projekt)
  - Falls nicht gesetzt, wird `FIREBASE_TOKEN` verwendet

## Firebase Token generieren

### Production Token

```bash
firebase login
firebase use ver1werk
firebase login:ci
```

Kopiere den generierten Token und setze ihn als `FIREBASE_TOKEN` Secret in GitHub.

### Development Token (optional)

```bash
firebase login
firebase use ver1werk-dev
firebase login:ci
```

Kopiere den generierten Token und setze ihn als `FIREBASE_TOKEN_DEV` Secret in GitHub.

## Deployment

### Production Deployment

Push auf `master` oder `main` Branch:

```bash
git checkout master
git push origin master
```

Der Workflow deployed automatisch zu `ver1werk`.

### Development Deployment

Push auf `development` Branch:

```bash
git checkout development
git push origin development
```

Der Workflow deployed automatisch zu `ver1werk-dev`.

## Manuelles Deployment

Falls du manuell deployen möchtest:

### Production

```bash
firebase use ver1werk
firebase deploy --only functions
```

### Development

```bash
firebase use ver1werk-dev
firebase deploy --only functions
```

## Troubleshooting

### Fehler: "Permission denied"

- Stelle sicher, dass du mit `firebase login` angemeldet bist
- Prüfe, dass der Token gültig ist (nicht abgelaufen)
- Stelle sicher, dass du Zugriff auf das entsprechende Firebase-Projekt hast

### Fehler: "Project not found"

- Prüfe, ob das Projekt in `.firebaserc` korrekt definiert ist
- Stelle sicher, dass du Zugriff auf das Projekt in der Firebase Console hast

### Fehler: "Functions successfully deployed but could not set up cleanup policy"

- Dieser Fehler wird automatisch abgefangen (mit `|| true`)
- Die Functions werden trotzdem deployed
- Das Cleanup-Policy kann manuell in der Firebase Console gesetzt werden

## Funktionen

Folgende Functions werden deployed:

- `generateMenuPDF` - Generiert PDF-Menüs
- `analyzeReceipt` - Analysiert Belege (OCR)
- `distributeOrder` - Verteilt Bestellungen
- `purchaseTrigger` - Trigger bei Käufen
- `itemAvailability` - Item-Verfügbarkeit Updates
- `refundHandler` - Refund-Verarbeitung
- `orderCreated` - Bestellungs-Erstellung Trigger
- `email-worker` - E-Mail-Warteschlange

Alle Functions werden in beiden Umgebungen (Production und Development) deployed.

## Firestore Datenbank-Konfiguration

Beide Umgebungen verwenden die `(default)` Datenbank:
- **Production** (`ver1werk`): `(default)` Datenbank
- **Development** (`ver1werk-dev`): `(default)` Datenbank

**Hinweis**: 
- Firestore Triggers in Firebase Functions v1 hören automatisch auf die `(default)` Datenbank
- Die Daten werden durch Projekt-Trennung isoliert (Development vs. Production)

