# ProudOne — UI & Frontend Backend-Wiring Specification

This document provides exact, step-by-step instructions for upgrading `ProudOne.html` to a **Play Store-quality responsive UI** and connecting it to the new **Cloudflare Worker API** (`worker.js`). 

You can hand this specification to any assistant model (e.g., Gemini Flash, Sonnet) to execute the frontend transformation without burning advanced model tokens.

---

## 1. Typography & Responsive Layout (CSS Rebuild)

### A. Add Premium Fonts
At the top of the `<head>` in `ProudOne.html`, add Google Fonts for **Inter** and **JetBrains Mono**:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

### B. Update CSS Variables (`:root`)
Replace the font variables and remove the hardcoded 480px width constraint:
```css
:root {
  /* ... existing color variables ... */
  --fn: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --mo: 'JetBrains Mono', 'Consolas', monospace;
  --max-w: 1040px; /* Upgraded from 480px for laptop/desktop support */
}
```

### C. Responsive Container Layout (`#app`)
Modify `#app` and responsive media queries so the app feels native on phones and spacious on laptops:
```css
#app {
  display: none;
  height: 100svh;
  width: 100%;
  max-width: var(--max-w);
  margin: 0 auto;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

/* Tablet & Laptop Styles (>= 640px) */
@media (min-width: 640px) {
  #app {
    border-left: 1px solid var(--bd);
    border-right: 1px solid var(--bd);
    box-shadow: var(--sh2);
  }
  
  .scr {
    padding: 24px 32px 40px !important;
  }

  /* Multi-column grids for wider screens */
  .prog-grid {
    grid-template-columns: repeat(3, 1fr) !important;
    gap: 16px !important;
  }
  
  .qa-row {
    grid-template-columns: repeat(4, 1fr) !important;
    gap: 14px !important;
  }
  
  .stat-grid {
    grid-template-columns: repeat(4, 1fr) !important;
  }
}
```

---

## 2. Home Screen Rebuild (Notion / Linear Aesthetic)

Redesign the `#s-home` section in `ProudOne.html` so it prioritizes visual clarity and progress tracking:

### Order of Elements on Home Screen:
1. **Header / Greeting**: 
   * Top bar displaying: `"GOOD MORNING / AFTERNOON, [NAME]"`
   * Subtitle: `"Discipline beats motivation. Show up today."`
   * Right side: Fire streak badge (`🔥 12d Streak`).

2. **Primary Progress Overview (`.prog-grid`)**:
   * Card 1: **Roadmap Progress** (Bar chart + `% complete`).
   * Card 2: **DSA Sheet** (`Solved / Total` + progress bar).
   * Card 3: **Daily Habits** (`X / Y Done Today` + progress bar).

3. **Today's Focus (Top 3 Tasks)**:
   * A clean container titled **"TODAY'S FOCUS"**.
   * Renders the top 3 uncompleted tasks with interactive, rounded checkmarks. If none exist, display a button: `"+ Add Focus Task"`.

4. **Activity Heatmap**:
   * Keep the 16-week GitHub-style activity grid, but place it inside a clean card with a subtle border.

---

## 3. Decluttered Navigation (More Tab)

Keep the main bottom navigation bar strictly focused on primary daily actions:
`[ Home ]  [ Study ]  [ Tasks ]  [ AI ]  [ More ]`

### Reorganize the "More" Tab (`#s-more`):
Move all utilities and secondary trackers out of main views and group them cleanly inside the **More** menu:
* **💪 Fitness & Health**: Gym / Workout Log, Meal Planner.
* **💰 Finance**: Expense Tracker & Daily Budget.
* **📊 Analytics & Social**: Weekly Review AI, Progress Share Card, Full Stats & Radar Chart.
* **⚙️ Account**: Profile Settings, Log Out.

---

## 4. Wiring Frontend to Cloudflare Worker Backend

### A. Authentication & Onboarding Upgrade
Replace the old Step 1 onboarding modal (which asked for a Groq API key) with a clean **Sign Up / Login** screen:
* **Inputs**: `Username`, `Password`, and optional `Invite Code` (`PO-ALPHA`).
* **API Call**: On submit, send `POST /api/auth/register` or `/api/auth/login` to the Worker.
* **Token Storage**: Save the returned JWT/bearer token:
  ```javascript
  localStorage.setItem('po_token', data.token);
  localStorage.setItem('po_user', JSON.stringify({ id: data.user_id, username: data.username }));
  ```

### B. Zero-Key AI Chat Proxy (`callAI()`)
Update the `callAI()` function in JavaScript so it communicates with your backend proxy instead of calling Groq directly from the browser:
```javascript
function callAI(sys, usr, maxTok, cb) {
  var token = localStorage.getItem('po_token');
  if (!token) { cb(null, 'NOT_LOGGED_IN'); return; }

  fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({
      system: sys,
      message: usr,
      max_tokens: maxTok || 900,
      temperature: 0.7
    })
  })
  .then(function(r) {
    if (!r.ok) return r.json().then(function(d) { throw new Error(d.error || 'API_ERROR'); });
    return r.json();
  })
  .then(function(d) {
    cb(d.reply || '', null);
  })
  .catch(function(err) {
    cb(null, err.message || 'NET_ERROR');
  });
}
```
*Remove the "API Key" menu (`m-api`) from the More tab entirely!*

### C. Cloud Workspace Data Sync
Add a background synchronization helper that mirrors `localStorage` changes to Cloudflare D1:
```javascript
var syncTimeout = null;
function saveCloud() {
  var token = localStorage.getItem('po_token');
  if (!token) return;
  
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(function() {
    fetch('/api/workspace/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({
        profile: G.profile,
        roadmap: G.rm,
        tasks: G.tasks,
        habits: G.hab,
        habit_names: G.hnames,
        expenses: G.exp,
        workouts: G.wo,
        dsa: G.dsa,
        sheet: G.sheet,
        activity: G.act,
        streaks: G.str,
        wins: G.wins
      })
    }).catch(function(e) { console.log('Sync error:', e); });
  }, 1500); // 1.5s debounce
}
```
*Call `saveCloud()` inside your existing `ss(k, v)` save helper so any change saved locally is automatically backed up to D1 in the background!*
