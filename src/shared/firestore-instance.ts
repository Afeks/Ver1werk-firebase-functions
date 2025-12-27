/**
 * Firestore-Instanz
 * 
 * Verwendet die (default) Datenbank (Standard für Firebase Functions)
 */

import * as admin from 'firebase-admin';

/**
 * Gibt die Firestore-Instanz zurück (verwendet (default) Datenbank)
 */
export function getFirestore(): FirebaseFirestore.Firestore {
  return admin.firestore();
}

