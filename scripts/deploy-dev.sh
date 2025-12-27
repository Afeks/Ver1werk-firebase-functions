#!/bin/bash
# Script zum Deployen der Development Functions
# Verwendung: ./scripts/deploy-dev.sh

set -e

echo "🔧 Deploye Development Functions..."

cd "$(dirname "$0")/.."

# Build
echo "📦 Building TypeScript..."
npm run build

# Deploy Development Functions
echo "🚀 Deploye Development Functions..."
firebase deploy --only functions:generateMenuPDFDev,functions:analyzeReceiptDev --project ver1werk

echo ""
echo "✅ Development Functions erfolgreich deployed!"
echo "🌐 Functions:"
echo "   - generateMenuPDFDev"
echo "   - analyzeReceiptDev"

