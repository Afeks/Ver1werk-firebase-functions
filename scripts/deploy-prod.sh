#!/bin/bash
# Script zum Deployen der Production Functions
# Verwendung: ./scripts/deploy-prod.sh

set -e

echo "🔧 Deploye Production Functions..."

cd "$(dirname "$0")/.."

# Build
echo "📦 Building TypeScript..."
npm run build

# Deploy Production Functions
echo "🚀 Deploye Production Functions..."
firebase deploy --only functions:generateMenuPDFProd,functions:analyzeReceiptProd --project ver1werk

echo ""
echo "✅ Production Functions erfolgreich deployed!"
echo "🌐 Functions:"
echo "   - generateMenuPDFProd"
echo "   - analyzeReceiptProd"

