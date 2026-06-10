// sync-results.js
// Fetches live FIFA World Cup 2026 group stage standings from ESPN
// and writes them to Firestore, then recalculates all user scores.
// Runs hourly via GitHub Actions.

const admin = require('firebase-admin');
const https = require('https');

// ── Name mapping: ESPN display names → app names ──────────────────────────────
const NAME_MAP = {
  'South Korea':        'Korea Republic',
  'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
  'United States':      'USA',
  'Ivory Coast':        "Côte d'Ivoire",
  'Iran':               'IR Iran',
  'Cape Verde':         'Cabo Verde',
};

// ── App's group definitions (used for score recalc) ──────────────────────────
const GROUPS = {
  A: ['Mexico','South Africa','Korea Republic','Czechia'],
  B: ['Canada','Bosnia & Herzegovina','Qatar','Switzerland'],
  C: ['Haiti','Scotland','Brazil','Morocco'],
  D: ['USA','Paraguay','Australia','Türkiye'],
  E: ["Côte d'Ivoire",'Ecuador','Germany','Curaçao'],
  F: ['Netherlands','Japan','Sweden','Tunisia'],
  G: ['IR Iran','New Zealand','Belgium','Egypt'],
  H: ['Saudi Arabia','Uruguay','Spain','Cabo Verde'],
  I: ['France','Senegal','Iraq','Norway'],
  J: ['Argentina','Algeria','Austria','Jordan'],
  K: ['Portugal','Congo DR','Uzbekistan','Colombia'],
  L: ['Ghana','Panama','England','Croatia']
};

function mapName(name) {
  return NAME_MAP[name] || name;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function parseStandings(data) {
  const results = {};
  for (const group of (data.children || [])) {
    const letter = group.name.replace('Group ', '');
    const entries = group.standings?.entries || group.entries || [];

    // Only write groups where at least one game has been played
    const gamesPlayed = entries.reduce((sum, e) => {
      return sum + (e.stats?.find(s => s.name === 'gamesPlayed')?.value || 0);
    }, 0);
    if (gamesPlayed === 0) continue;

    const sorted = [...entries].sort((a, b) => {
      const ra = a.stats?.find(s => s.name === 'rank')?.value ?? 99;
      const rb = b.stats?.find(s => s.name === 'rank')?.value ?? 99;
      return ra - rb;
    });
    results[letter] = sorted.map(e => mapName(e.team?.displayName));
  }
  return results;
}

function scoreGroup(userPicks, actual) {
  if (!actual || actual.length < 4) return 0;
  let pts = 0;
  const PTS = [4, 3, 2, 1];
  for (let i = 0; i < 4; i++) {
    if (!userPicks[i]) continue;
    if (userPicks[i] === actual[i]) {
      pts += PTS[i];
    } else if (i < 2) {
      if (actual[0] === userPicks[i] || actual[1] === userPicks[i]) pts += 2;
    }
  }
  return pts;
}

async function main() {
  // Init Firebase Admin from GitHub secret
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  // Fetch live standings from ESPN (no API key needed)
  console.log('Fetching standings from ESPN...');
  const data = await fetchJSON(
    'https://site.web.api.espn.com/apis/v2/sports/soccer/FIFA.WORLD/standings?season=2026'
  );
  const results = parseStandings(data);

  if (Object.keys(results).length === 0) {
    console.log('No groups with completed matches yet — nothing to write.');
    return;
  }

  console.log('Groups with results:', Object.keys(results).join(', '));

  // Write to Firestore results/groups
  await db.collection('results').doc('groups').set(results, { merge: true });
  console.log('Results written to Firestore.');

  // Recalculate scores for all users
  const snap = await db.collection('picks').get();
  if (snap.empty) {
    console.log('No picks submitted yet.');
    return;
  }

  // Fetch full current results doc (includes previously written groups)
  const resultsDoc = await db.collection('results').doc('groups').get();
  const allResults = resultsDoc.data() || {};

  const batch = db.batch();
  snap.forEach(doc => {
    const d = doc.data();
    let total = 0;
    for (const g of Object.keys(GROUPS)) {
      if (d.picks?.[g] && allResults[g]) {
        total += scoreGroup(d.picks[g], allResults[g]);
      }
    }
    batch.update(doc.ref, { score: total });
  });
  await batch.commit();
  console.log(`Scores recalculated for ${snap.size} user(s).`);
}

main().catch(err => { console.error('Sync failed:', err); process.exit(1); });
