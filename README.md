# OrderCat Firebase Functions

Dieses Repository enthält Firebase Functions für die OrderCat-Anwendung, speziell die Funktionalität zur Verteilung von Bestellungen auf Points of Sale.

## 🚀 Automatisches Deployment

Dieses Projekt verwendet GitHub Actions für automatisches Deployment. Bei jedem Push auf den `main` Branch werden die Functions automatisch auf Firebase deployed.

### Setup für automatisches Deployment

1. Erstelle ein Firebase Service Account:
   - Gehe zu Firebase Console > Project Settings > Service Accounts
   - Klicke auf "Generate new private key"
   - Lade die JSON-Datei herunter
   - **Wichtig**: Kopiere den kompletten Inhalt der JSON-Datei (als String)

2. Füge GitHub Secrets hinzu:
   - Gehe zu deinem GitHub Repository > Settings > Secrets and variables > Actions
   - Füge folgende Secrets hinzu:
     - `FIREBASE_SERVICE_ACCOUNT`: Der komplette Inhalt der Service Account JSON-Datei (als String einfügen)
     - `FIREBASE_PROJECT_ID`: Deine Firebase Projekt-ID (z.B. "ordercat")
   
   **Hinweis**: Der Service Account benötigt die Berechtigung "Firebase Admin SDK Administrator Service Agent" oder "Editor" Rolle, um Functions deployen zu können.

## Funktionen

### `distributeOrderFunction`

Eine Callable Function, die eine Bestellung auf verschiedene Points of Sale verteilt basierend auf dem `DistributionMode`.

**Verwendung:** Manuell über HTTP/API

### `onPurchaseCreated`

Eine Firestore Trigger Function, die **automatisch** ausgelöst wird, wenn eine neue Hauptbestellung (Purchase) in Firestore erstellt wird. Die Bestellung wird automatisch auf die Points of Sale verteilt.

**Trigger Pfad:** `Events/{eventId}/Orders/{purchaseId}`

**Verwendung:** Automatisch - keine manuelle Ausführung nötig

**Verwendung:**

```typescript
import { getFunctions, httpsCallable } from 'firebase/functions';

const functions = getFunctions();
const distributeOrder = httpsCallable(functions, 'distributeOrderFunction');

const result = await distributeOrder({
  eventId: 'your-event-id',
  items: [
    {
      id: 'item-1',
      name: 'Pizza Margherita',
      price: 12.50,
      selectedExtras: [],
      excludedIngredients: []
    }
  ],
  servingPoint: {
    id: 'table-1',
    name: 'Tisch 1',
    location: 'Innenbereich',
    capacity: 4
  },
  userId: 'user-123',
  distributionMode: 'balanced', // oder 'grouped'
  note: 'Bitte keine Zwiebeln'
});
```

## Installation

```bash
git clone <repository-url>
cd distributeOrder
npm install
```

## Firebase Setup

Bevor du die Functions deployen kannst, musst du Firebase initialisieren:

```bash
# Im Hauptverzeichnis des Projekts (OrderCat/)
firebase login
firebase use --add  # Wähle dein Projekt (ordercat)
```

Oder direkt mit Projekt-ID:

```bash
firebase use ordercat
```

## Entwicklung

```bash
# TypeScript kompilieren
npm run build

# Firebase Emulator starten (für lokale Tests)
npm run serve
# Oder vom Hauptverzeichnis:
firebase emulators:start --only functions

# Funktionen deployen (vom Hauptverzeichnis)
firebase deploy --only functions

# Oder aus dem firebase_functions Ordner:
cd firebase_functions
npm run deploy
```

## Verteilung Modi

### Balanced Mode (Standard)
Verteilt Items auf den Point of Sale mit der geringsten Anzahl offener Bestellungen. Dies sorgt für eine gleichmäßige Auslastung.

### Grouped Mode
*Noch nicht implementiert* - Würde Items zusammenfassen, um möglichst viele Items an einem Point of Sale zu bearbeiten.

## Automatische Verteilung

Die Function `onPurchaseCreated` wird automatisch ausgelöst, wenn:
- Eine neue Bestellung in `Events/{eventId}/Orders/{purchaseId}` erstellt wird
- Die Bestellung hat noch kein `distributed: true` Flag

Die Function:
1. Lädt die Bestelldaten aus Firestore
2. Lädt das ServingPoint (Tisch) basierend auf `tableId`
3. Lädt alle Items aus der `Items` Sub-Collection
4. Lädt den `distributionMode` aus dem Event
5. Verteilt die Bestellung automatisch auf die Points of Sale
6. Markiert die Bestellung als `distributed: true`

**Wichtig:** 
- Die Function verhindert doppelte Verteilung durch das `distributed` Flag.
- **Hinweis zu Extras/Ingredients:** Die Purchase Items Sub-Collection speichert nur `itemId` und `quantity`. `selectedExtras` und `excludedIngredients` werden nicht in der Purchase gespeichert, sondern erst bei der Erstellung der DistributedPurchases. Daher werden diese beim automatischen Trigger nicht berücksichtigt und bleiben leer. Wenn Extras/Ingredients benötigt werden, sollte die manuelle `distributeOrderFunction` verwendet werden.

## Projektstruktur

```
distributeOrder/
├── src/
│   ├── index.ts                      # Haupt-Entry-Point, exportiert alle Functions
│   ├── types.ts                      # TypeScript Typen und Interfaces
│   ├── database-helpers.ts           # Helper-Funktionen für Firestore-Zugriffe
│   ├── distribute-order.ts          # Hauptlogik für die Verteilung
│   └── trigger-order-distribution.ts # Firestore Trigger für automatische Verteilung
├── .github/
│   └── workflows/
│       └── deploy.yml                # GitHub Actions Workflow für automatisches Deployment
├── lib/                              # Kompilierte JavaScript-Dateien (generiert)
├── firebase.json                     # Firebase Konfiguration
├── package.json
├── tsconfig.json
└── README.md
```

## Abhängigkeiten

- `firebase-admin`: Für Firestore-Zugriffe
- `firebase-functions`: Für Callable Functions
- `uuid`: Für die Generierung eindeutiger IDs
- `typescript`: Für TypeScript-Unterstützung

