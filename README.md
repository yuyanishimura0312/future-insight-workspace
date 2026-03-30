# Future Insight Workspace

A multi-user strategic foresight platform for performing personal future insight work.

## Features

- **Shared Data**: Browse PESTLE news, CLA analysis, scenarios, and weak signals from the main Future Insight App
- **Personal Workspace**: Bookmarks, observation journal, driving forces, scenario building, signal tracking
- **User Management**: Admin panel for user approval and management
- **Authentication**: Firebase Auth with email/password

## Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project (e.g., "future-insight-workspace")
3. Enable **Authentication** > Email/Password provider
4. Create **Firestore Database** (start in test mode)
5. Go to Project Settings > General > Your apps > Add web app
6. Copy the Firebase config values

### 2. Configure

Edit `js/firebase-config.js` and replace the placeholder values with your Firebase config.

### 3. Firestore Security Rules

In Firebase Console > Firestore > Rules, set:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == userId;
    }
    match /users/{userId}/{subcollection}/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### 4. Create Admin User

1. Sign up through the app
2. In Firebase Console > Firestore > users collection, find your user document
3. Change `status` from `"pending"` to `"active"` and `role` from `"user"` to `"admin"`

### 5. Deploy

```bash
git push origin main
```

Enable GitHub Pages in repo Settings > Pages > Source: main branch.

### 6. Add Authorized Domain

In Firebase Console > Authentication > Settings > Authorized domains, add:
`yuyanishimura0312.github.io`

## Architecture

- Frontend: Vanilla HTML/CSS/JS (no build step)
- Auth & Data: Firebase Auth + Firestore
- Shared Data: Fetched from https://yuyanishimura0312.github.io/future-insight-app/data/
- Hosting: GitHub Pages
