#!/bin/bash
# Cortex — Deploy to Cloud Run
# Run after setup.sh has been run at least once

set -e

# Load env
if [ -f .env ]; then
  source .env
fi

if [ -z "$PROJECT_ID" ] || [ -z "$GOOGLE_API_KEY" ]; then
  echo "[!] Missing PROJECT_ID or GOOGLE_API_KEY. Run setup.sh first."
  exit 1
fi

export REGION="${REGION:-us-central1}"

echo "========================================="
echo "  Deploying Cortex to Cloud Run"
echo "========================================="

# Build and push backend
echo "[...] Building backend container..."
cd backend
gcloud builds submit --tag gcr.io/$PROJECT_ID/cortex-backend --quiet
cd ..
echo "[✓] Backend image built"

# Deploy to Cloud Run
echo "[...] Deploying to Cloud Run..."
gcloud run deploy cortex-backend \
  --image gcr.io/$PROJECT_ID/cortex-backend \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_API_KEY=$GOOGLE_API_KEY,PROJECT_ID=$PROJECT_ID \
  --memory 1Gi \
  --concurrency 100 \
  --quiet

# Get URL
BACKEND_URL=$(gcloud run services describe cortex-backend \
  --platform managed --region $REGION --format 'value(status.url)')

echo ""
echo "========================================="
echo "  DEPLOYED"
echo "========================================="
echo ""
echo "  Backend URL: $BACKEND_URL"
echo "  Health check: $BACKEND_URL/health"
echo "  Graph API:    $BACKEND_URL/graph"
echo ""
echo "  Update Chrome Extension popup with:"
echo "  WebSocket: ${BACKEND_URL/https/wss}/ws"
echo ""
echo "  Update frontend .env with:"
echo "  REACT_APP_BACKEND_URL=$BACKEND_URL"
echo "  REACT_APP_BACKEND_WS=${BACKEND_URL/https/wss}/ws"
echo "========================================="
