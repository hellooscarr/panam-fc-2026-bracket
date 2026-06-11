// sync-results.js
// Fetches live FIFA World Cup 2026 standings + knockout bracket from ESPN
// Writes to Firestore, recalculates all user scores.
// Runs hourly via GitHub Actions.
//
// Group-stage scoring only awards points for a position once the team listed
// in that position has actually played a game. This avoids handing out points
// based on ESPN's tiebreak ordering of teams that are still tied 0-0-0-0
// (which can also shift run-to-run for tied teams).

const admin = require('firebase-admin');
const https = require('https');

// ── Name mapping: ESPN display names → app names ─────────────────────────────
const NAME_MAP = {
  'South Korea':        'Korea Republic',
  'Bosnia-Herzegovina': 'Bosnia & Herzegovina',
  'United States':      'USA',
  'Ivory Coast':        "Côte d'Ivoire",
  'Iran':               'IR Iran',
  'Cape Verde':         'Cabo Verde',
};

// ── App's group definitions ──────────────────────────────────────────────────
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

// ── Playoff constants ────────────────────────────────────────────────────────
const PLAYOFF_ROUNDS = ['R32','R16','QF','SF','F'];
const ROUND_COUNTS   = {R32:16, R16:8, QF:4, SF:2, F:1};
const ROUND_PTS      = {R32:1, R16:2, QF:3, SF:4, F:5};

// ESPN season type IDs for each knockout round
const ESPN_ROUND_TYPES = {
  R32: 13801,
  R16: 13800,
  QF:  13799,
  SF:  13798,
  F:   13797,
};

function mapName(name) {
  return NAME_MAP[name] || name;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// ── Parse group standings ────────────────────────────────────────────────────
// NOTE: also returns `gamesPlayedByGroup`, a map of
//   { [groupLetter]: { [teamName]: gamesPlayed } }
// so the scoring step can tell which positions are backed by an actual result.
function parseStandings(data) {
  const results = {};
  const teamIdToName = {};
  const gamesPlayedByGroup = {};

  for (const group of (data.children || [])) {
    const letter = group.name.replace('Group ', '');
    const entries = group.standings?.entries || group.entries || [];

    // Build team ID → name lookup, and per-team gamesPlayed for this group
    const gp = {};
    for (const e of entries) {
      if (e.team?.id && e.team?.displayName) {
        teamIdToName[String(e.team.id)] = mapName(e.team.displayName);
      }
      const name = mapName(e.team?.displayName);
      if (name) gp[name] = e.stats?.find(s => s.name === 'gamesPlayed')?.value || 0;
    }
    gamesPlayedByGroup[letter] = gp;

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

  return { results, teamIdToName, gamesPlayedByGroup };
}

// ── Fetch knockout bracket from ESPN ────────────────────────────────────────
async function fetchKnockoutBracket(teamIdToName) {
  const bracket = {};

  for (const round of PLAYOFF_ROUNDS) {
    const typeId = ESPN_ROUND_TYPES[round];
    if (!typeId) continue;

    try {
      const url = `https://sports.core.api.espn.com/v2/sports/soccer/leagues/FIFA.WORLD/events?season=2026&seasontypes=${typeId}&limit=50`;
      const data = await fetchJSON(url);

      if (!data.items || data.items.length === 0) {
        console.log(`  ${round}: no events yet`);
        continue;
      }

      const matches = [];
      for (const item of data.items) {
        try {
          const ref = (item.$ref || '').replace('http://', 'https://');
          if (!ref) continue;
          const ev = await fetchJSON(ref);

          // Parse teams from event name: "AwayTeam at HomeTeam"
          let home = '', away = '';
          const evName = ev.name || '';
          if (evName.includes(' at ')) {
            const parts = evName.split(' at ');
            away = mapName(parts[0].trim());
            home = mapName(parts[1].trim());
          }

          // Use competitor IDs as fallback / for winner detection
          const comps = ev.competitions?.[0]?.competitors || [];
          let winner = null;
          for (const comp of comps) {
            const tName = teamIdToName[String(comp.id)];
            if (tName) {
              if (comp.homeAway === 'home' && !home) home = tName;
              if (comp.homeAway === 'away' && !away) away = tName;
            }
            if (comp.winner === true && tName) winner = tName;
          }

          if (!home && !away) continue; // bracket not set

          matches.push({ home: home || 'TBD', away: away || 'TBD', winner: winner || null });
        } catch(e) {
          console.warn(`    Event fetch error: ${e.message}`);
        }
      }

      if (matches.length > 0) {
        bracket[round] = matches;
        console.log(`  ${round}: ${matches.length} match(es) fetched`);
      }
    } catch(e) {
      console.warn(`  ${round}: round fetch failed — ${e.message}`);
    }
  }

  return bracket;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// `gp` is the gamesPlayed map for this group: { teamName: gamesPlayed }.
// A position only scores once the team that actually landed there (`actual[i]`)
// has played at least one game — otherwise that slot is still "TBD" and
// contributes 0, regardless of what the user picked.
function scoreGroup(userPicks, actual, gp = {}) {
  if (!actual || actual.length < 4) return 0;
  let pts = 0;
  const PTS = [4, 3, 2, 1];
  const played = (team) => (gp[team] || 0) > 0;

  for (let i = 0; i < 4; i++) {
    if (!userPicks[i]) continue;
    if (userPicks[i] === actual[i] && played(actual[i])) {
      pts += PTS[i];
    } else if (i < 2) {
      if (
        (actual[0] === userPicks[i] && played(actual[0])) ||
        (actual[1] === userPicks[i] && played(actual[1]))
      ) pts += 2;
    }
  }
  return pts;
}

function scorePlayoffs(userPlayoffPicks, bracket) {
  let pts = 0;
  for (const round of PLAYOFF_ROUNDS) {
    const count = ROUND_COUNTS[round];
    for (let i = 0; i < count; i++) {
      const actual = bracket[round]?.[i]?.winner;
      if (actual && userPlayoffPicks[`${round}-${i}`] === actual) pts += ROUND_PTS[round];
    }
  }
  return pts;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  // ── 1. Group stage standings ──
  console.log('Fetching group standings...');
  const standingsData = await fetchJSON(
    'https://site.web.api.espn.com/apis/v2/sports/soccer/FIFA.WORLD/standings?season=2026'
  );
  const { results, teamIdToName, gamesPlayedByGroup } = parseStandings(standingsData);

  if (Object.keys(results).length === 0) {
    console.log('No group results yet.');
  } else {
    console.log('Groups with results:', Object.keys(results).join(', '));
    // Store gamesPlayed alongside the standings under `_gamesPlayed` so the
    // recalculation step below (and the frontend) can use it. `_gamesPlayed`
    // doesn't collide with group letters A-L.
    await db.collection('results').doc('groups').set(
      { ...results, _gamesPlayed: gamesPlayedByGroup },
      { merge: true }
    );
    console.log('Group results written.');
  }

  // ── 2. Knockout bracket ──
  console.log('Fetching knockout bracket...');
  const bracket = await fetchKnockoutBracket(teamIdToName);

  if (Object.keys(bracket).length > 0) {
    await db.collection('results').doc('playoff').set(bracket, { merge: true });
    console.log('Playoff bracket written.');

    // Auto-unlock when full R32 bracket is set with real teams
    if (bracket.R32 && bracket.R32.length >= 16) {
      const allKnown = bracket.R32.every(m => m.home !== 'TBD' && m.away !== 'TBD');
      if (allKnown) {
        await db.collection('settings').doc('global').set({ playoffUnlocked: true }, { merge: true });
        console.log('Playoff tab auto-unlocked — R32 is set!');
      }
    }
  } else {
    console.log('Knockout bracket not available yet.');
  }

  // ── 3. Recalculate all scores ──
  const snap = await db.collection('picks').get();
  if (snap.empty) { console.log('No picks yet.'); return; }

  const groupsDoc  = await db.collection('results').doc('groups').get();
  const allResults = groupsDoc.exists ? groupsDoc.data() : {};
  const allGamesPlayed = allResults._gamesPlayed || {};
  const playoffDoc = await db.collection('results').doc('playoff').get();
  const allBracket = playoffDoc.exists ? playoffDoc.data() : {};

  const batch = db.batch();
  snap.forEach(doc => {
    const d = doc.data();
    let gs = 0;
    for (const g of Object.keys(GROUPS)) {
      if (d.picks?.[g] && allResults[g]) gs += scoreGroup(d.picks[g], allResults[g], allGamesPlayed[g]);
    }
    const ps = d.playoffPicks ? scorePlayoffs(d.playoffPicks, allBracket) : 0;
    batch.update(doc.ref, { score: gs, playoffScore: ps, totalScore: gs + ps });
  });
  await batch.commit();
  console.log(`Scores updated for ${snap.size} user(s).`);
}

main().catch(err => { console.error('Sync failed:', err); process.exit(1); });
