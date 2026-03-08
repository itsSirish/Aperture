#!/bin/bash
# Cortex — One-click Cloud Shell Setup
# Run: bash setup.sh

set -e

echo "========================================="
echo "  CORTEX — Cloud Shell Setup"
echo "========================================="

# ── 1. Project Config ──────────────────────────────────────────────────
export PROJECT_ID="gcloud-hackathon-zh35ve6flgohl"
export REGION="us-central1"
gcloud config set project $PROJECT_ID
echo "[✓] Project set to $PROJECT_ID"

# ── 2. Enable APIs ────────────────────────────────────────────────────
echo "[...] Enabling GCP APIs..."
gcloud services enable \
  aiplatform.googleapis.com \
  firestore.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  --quiet
echo "[✓] APIs enabled"

# ── 3. Firestore ──────────────────────────────────────────────────────
echo "[...] Setting up Firestore..."
gcloud firestore databases create --location=$REGION --quiet 2>/dev/null || echo "[✓] Firestore already exists"
echo "[✓] Firestore ready"

# ── 4. API Key ────────────────────────────────────────────────────────
if [ -z "$GOOGLE_API_KEY" ]; then
  echo ""
  echo "========================================="
  echo "  NEED YOUR GEMINI API KEY"
  echo "========================================="
  echo "  1. Go to: https://aistudio.google.com/app/apikey"
  echo "  2. Click 'Create API Key'"
  echo "  3. Select project: $PROJECT_ID"
  echo "  4. Copy the key and paste below"
  echo "========================================="
  echo ""
  read -p "Paste your Gemini API key: " GOOGLE_API_KEY
  export GOOGLE_API_KEY
fi

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "[!] No API key provided. Exiting."
  exit 1
fi
echo "[✓] API key set"

# Save env for later use
cat > .env << EOF
GOOGLE_API_KEY=$GOOGLE_API_KEY
PROJECT_ID=$PROJECT_ID
REGION=$REGION
EOF
echo "[✓] .env file created"

# ── 5. Install Backend ───────────────────────────────────────────────
echo "[...] Installing backend dependencies..."
cd backend
pip install -r requirements.txt --quiet 2>&1 | tail -1
cd ..
echo "[✓] Backend dependencies installed"

# ── 6. Install Frontend ──────────────────────────────────────────────
echo "[...] Installing frontend dependencies..."
cd frontend
npm install --silent 2>&1 | tail -1
cd ..
echo "[✓] Frontend dependencies installed"

# ── 7. Start Services ────────────────────────────────────────────────
echo ""
echo "========================================="
echo "  SETUP COMPLETE — Starting services"
echo "========================================="
echo ""
echo "Starting backend on port 8080..."
cd backend
uvicorn main:app --host 0.0.0.0 --port 8080 &
BACKEND_PID=$!
cd ..
sleep 2

echo "Starting frontend on port 3000..."
cd frontend
PORT=3000 REACT_APP_BACKEND_URL=http://localhost:8080 REACT_APP_BACKEND_WS=ws://localhost:8080/ws npm start &
FRONTEND_PID=$!
cd ..

echo ""
echo "========================================="
echo "  CORTEX IS RUNNING"
echo "========================================="
echo ""
echo "  Backend:  http://localhost:8080"
echo "  Frontend: http://localhost:3000"
echo "  Health:   http://localhost:8080/health"
echo ""
echo "  Use Cloud Shell 'Web Preview' (top-right)"
echo "  to open port 8080 (API) or 3000 (UI)"
echo ""
echo "  Chrome Extension:"
echo "    1. Download the extension/ folder to your Mac"
echo "    2. chrome://extensions → Developer Mode → Load Unpacked"
echo "    3. Set backend URL in popup to your Cloud Shell preview URL"
echo ""
echo "  To deploy to Cloud Run later:"
echo "    bash deploy.sh"
echo ""
echo "  Press Ctrl+C to stop all services"
echo "========================================="

# Wait for both processes
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
