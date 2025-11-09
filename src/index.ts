/**
 * Firebase Functions Entry Point
 * Exportiert alle Functions für das Projekt
 */

import * as admin from 'firebase-admin';

// Initialisiere Firebase Admin (nur einmal)
if (!admin.apps.length) {
  admin.initializeApp();
}

// Exportiere alle Functions
export { distributeOrderFunction } from './functions/distributeOrder';
export { onPurchaseCreated } from './functions/purchaseTrigger';
export { generateMenuPDF } from './functions/generateMenuPDF';
export { onPosItemAvailabilityChanged } from './functions/itemAvailability';
export { onNotificationRefundUpdate } from './functions/refundHandler';
