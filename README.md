# NEPSE Stock Predictor & Terminal

A full-stack Node.js application for real-time NEPSE (Nepal Stock Exchange) data scraping, technical indicator calculation, AI-driven analysis, and email alerts.

## Setup Instructions

### 1. Get OpenRouter API Key
- Go to [OpenRouter.ai](https://openrouter.ai/) and create a free account.
- Navigate to Keys and create a new API key. The `nvidia/nemotron-ultra-253b-v1:free` model is used by default.

### 2. Get Gmail App Password
- You cannot use your standard Gmail password.
- Go to your Google Account Manage Settings -> Security.
- Enable 2-Step Verification if you haven't already.
- Search for "App passwords" in the search bar. Create a new app password for "Mail". It will generate a 16-character code.

### 3. GitHub Codespaces Setup
- Open this repository in GitHub Codespaces.
- Go to **Settings -> Secrets -> Codespaces** in your GitHub repository and add the following secrets:
  - `OPENROUTER_API_KEY`: Your OpenRouter Key
  - `EMAIL_USER`: Your Gmail address
  - `EMAIL_PASS`: Your 16-character app password
  - `NOTIFY_EMAIL`: Where you want to receive alerts
- Alternatively, create a `.env` file in the root directory and paste these variables (see `.env.example`).

### 4. Running the App
Install dependencies and start the server:
```bash
npm install
npm start