/**
 * Datenbank-Konfiguration für Firebase Functions
 * 
 * Beide Umgebungen verwenden die (default) Datenbank.
 * 
 * Production (ver1werk): (default)
 * Development (ver1werk-dev): (default)
 */

/**
 * Gibt die Datenbank-ID zurück - immer (default)
 */
export function getDatabaseId(): string {
  return '(default)';
}

