terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP project ID"
}

variable "api_key" {
  description = "Gemini API key"
  sensitive   = true
}

variable "region" {
  default = "us-central1"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "firestore" {
  service            = "firestore.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudbuild" {
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

# Cloud Run backend
resource "google_cloud_run_v2_service" "cortex_backend" {
  name     = "cortex-backend"
  location = var.region

  depends_on = [google_project_service.run]

  template {
    containers {
      image = "gcr.io/${var.project_id}/cortex-backend:latest"

      env {
        name  = "GOOGLE_API_KEY"
        value = var.api_key
      }
      env {
        name  = "PROJECT_ID"
        value = var.project_id
      }

      resources {
        limits = {
          memory = "1Gi"
          cpu    = "1"
        }
      }

      ports {
        container_port = 8080
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Allow unauthenticated access
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.cortex_backend.name
  location = google_cloud_run_v2_service.cortex_backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Firestore database
resource "google_firestore_database" "cortex" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.firestore]
}

output "backend_url" {
  value = google_cloud_run_v2_service.cortex_backend.uri
}
