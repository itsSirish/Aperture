# Cortex — Ambient AI Intelligence Agent

> Your work, made visible. Your context, never lost.

Cortex is a persistent ambient AI agent that silently watches your work across browser tabs, forms a live knowledge graph of beliefs, and lets you talk to it via Gemini Live voice.

## Architecture

```
Chrome Extension  -->  FastAPI WebSocket  -->  Gemini Live (voice)
     (tabs)              (backend)              Gemini Flash (beliefs)
                            |
                        Firestore
                            |
                    React + D3 Graph (frontend)
```

## Prerequisites

- Python 3.11+, Node 18+, Docker
- Google Cloud CLI authenticated
- Chrome browser
- Gemini API key

## Quick Start

### 1. Environment

```bash
cp .env.example .env
# Fill in: GOOGLE_API_KEY, PROJECT_ID
```

### 2. Backend

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8080
```

### 3. Chrome Extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click "Load Unpacked" and select the `/extension` folder

### 4. Frontend

```bash
cd frontend
npm install
npm start
```

### 5. Docker (alternative)

```bash
docker-compose up --build
```

## Cloud Deployment

```bash
# Build and push
gcloud builds submit --tag gcr.io/$PROJECT_ID/cortex-backend ./backend

# Deploy
gcloud run deploy cortex-backend \
  --image gcr.io/$PROJECT_ID/cortex-backend \
  --platform managed --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_API_KEY=$GOOGLE_API_KEY,PROJECT_ID=$PROJECT_ID

# Or via Terraform
cd terraform && terraform init
terraform apply -var="project_id=$PROJECT_ID" -var="api_key=$GOOGLE_API_KEY"
```

## Demo Moments

1. **Insight**: "What have I been working on today?" — graph-grounded answer
2. **Restoration**: "Take me back to where I was an hour ago." — tabs reopen
3. **Email**: "Draft an email to my advisor about the research." — 7 words, perfect email
