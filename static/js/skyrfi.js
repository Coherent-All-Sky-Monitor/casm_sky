// skyrfi.js - refactored script from skyrfi.html
// Globals expected: Plotly, satellite

// Quick runtime checks and error banner helper to surface issues in-page
function showBanner(msg, isError = true) {
    try {
        let existing = document.getElementById('skyrfi-banner');
        if (!existing) {
            existing = document.createElement('div');
            existing.id = 'skyrfi-banner';
            existing.style.position = 'fixed';
            existing.style.left = '12px';
            existing.style.right = '12px';
            existing.style.top = '12px';
            existing.style.zIndex = 9999;
            existing.style.padding = '10px 14px';
            existing.style.borderRadius = '6px';
            existing.style.fontFamily = 'monospace';
            existing.style.fontSize = '13px';
            document.body.appendChild(existing);
        }
        existing.style.background = isError ? 'rgba(200,40,40,0.95)' : 'rgba(40,120,200,0.95)';
        existing.style.color = '#fff';
        existing.innerText = msg;
    } catch (e) {
        console.warn('showBanner failed', e);
    }
}

window.addEventListener('error', function (ev) {
    showBanner('Runtime error: ' + (ev && ev.message ? ev.message : String(ev)), true);
});

console.log('skyrfi.js loaded');

function runtimeCheck() {
    const missing = [];
    if (typeof Plotly === 'undefined') missing.push('Plotly');
    if (typeof satellite === 'undefined') missing.push('satellite.js');
    const ids = ['polar','rect','clock-utc','clock-obs','clock-user','count-sat','count-plane'];
    ids.forEach(id => { if (!document.getElementById(id)) missing.push(`missing DOM #${id}`); });
    if (missing.length) {
        showBanner('Startup check failed: ' + missing.join(', '), true);
        console.warn('Startup missing:', missing);
        return false;
    }
    return true;
}

const SK_CONFIG = {
    OBSERVER: { lat: 37.2317, lon: -118.2951, alt: 1.222 },
    PANORAMA_ID: 'BTV9VXUH',
    BEAM_WIDTH_DEG: 100,
    PLANE_SEARCH_RADIUS_NM: 200,
    TLE_FETCH_MS: 3 * 60 * 60 * 1000,
    PLANE_FETCH_MS: 1000,
    MATH_UPDATE_MS: 100
};

// Public state (attach to window for debugging)
const SK_STATE = {
    satRecords: [],
    planes: {},
    horizon: { az: [], alt: [] },
    plotInitialized: false
};

// ----- LocalStorage caching helpers -----
async function cachedFetchText(url, storageKey, ttl) {
    const now = Date.now();
    try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
            const obj = JSON.parse(raw);
            if (now - obj.ts < ttl) return obj.data;
        }
    } catch (e) { /* ignore parse errors */ }
    const r = await fetch(url);
    const text = await r.text();
    try { localStorage.setItem(storageKey, JSON.stringify({ ts: now, data: text })); } catch (e) {}
    return text;
}

async function cachedFetchJson(url, storageKey, ttl) {
    const now = Date.now();
    try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
            const obj = JSON.parse(raw);
            if (now - obj.ts < ttl) return obj.data;
        }
    } catch (e) {}
    const r = await fetch(url);
    const data = await r.json();
    try { localStorage.setItem(storageKey, JSON.stringify({ ts: now, data })); } catch(e) {}
    return data;
}

// ----- Utility helpers -----
function getGroup(name) {
    if (name.includes('STARLINK')) return 'STARLINK';
    if (name.includes('MUOS')) return 'MUOS';
    if (name.includes('GPS')) return 'GPS';
    if (name.includes('ONEWEB')) return 'ONEWEB';
    return 'OTHER';
}

function getHorizonLimit(azDeg) {
    const h = SK_STATE.horizon;
    if (!h || h.az.length === 0) return -5;
    let az = (azDeg % 360 + 360) % 360;
    let l = 0, r = h.az.length - 1;
    while (l <= r) {
        let m = (l + r) >>> 1;
        if (h.az[m] < az) l = m + 1; else r = m - 1;
    }
    let i1 = r < 0 ? h.az.length - 1 : r;
    let i2 = l >= h.az.length ? 0 : l;
    let az1 = h.az[i1], alt1 = h.alt[i1], az2 = h.az[i2], alt2 = h.alt[i2];
    let run = (az2 - az1 + 360) % 360;
    if (run === 0) return alt1;
    return alt1 + ((alt2 - alt1) / run) * ((az - az1 + 360) % 360);
}

// ----- Data fetchers -----
async function fetchHorizon() {
    const localPath = `/static/horizon_${SK_CONFIG.PANORAMA_ID}.csv`;
    const remoteUrl = `https://corsproxy.io/?https://www.heywhatsthat.com/api/horizon.csv?id=${SK_CONFIG.PANORAMA_ID}&resolution=.1`;
    const HORIZON_TTL = 365 * 24 * 60 * 60 * 1000; // 1 year
    try {
        const text = await cachedFetchText(localPath, `horizon_${SK_CONFIG.PANORAMA_ID}`, HORIZON_TTL);
        parseHorizonCsv(text);
    } catch (e) {
        try {
            const text = await cachedFetchText(remoteUrl, `horizon_${SK_CONFIG.PANORAMA_ID}`, HORIZON_TTL);
            parseHorizonCsv(text);
        } catch (e2) {
            console.warn('Failed to load horizon:', e2);
        }
    }
}

function parseHorizonCsv(text) {
    const lines = text.split('\n');
    const az = [], alt = [];
    for (let i = 1; i < lines.length; i++) {
        const p = lines[i].split(',');
        if (p.length >= 3) { az.push(parseFloat(p[1])); alt.push(parseFloat(p[2])); }
    }
    const c = az.map((a, i) => ({ a: a, e: alt[i] })).sort((a, b) => a.a - b.a);
    SK_STATE.horizon.az = c.map(x => x.a);
    SK_STATE.horizon.alt = c.map(x => x.e);
}

async function fetchTLEs() {
    try {
        const text = await cachedFetchText('https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle', 'tles_active', SK_CONFIG.TLE_FETCH_MS);
        const lines = text.split('\n');
        SK_STATE.satRecords = [];
        for (let i = 0; i < lines.length; i += 3) {
            if (lines[i]) {
                const rec = satellite.twoline2satrec(lines[i+1].trim(), lines[i+2].trim());
                rec.name = lines[i].trim();
                rec.group = getGroup(rec.name);
                SK_STATE.satRecords.push(rec);
            }
        }
    } catch (e) { console.warn('TLE fetch failed', e); }
}

async function fetchPlanes() {
    const url = `https://corsproxy.io/?https://api.airplanes.live/v2/point/${SK_CONFIG.OBSERVER.lat}/${SK_CONFIG.OBSERVER.lon}/${SK_CONFIG.PLANE_SEARCH_RADIUS_NM}`;
    try {
        const storageKey = `planes_${SK_CONFIG.OBSERVER.lat}_${SK_CONFIG.OBSERVER.lon}_${SK_CONFIG.PLANE_SEARCH_RADIUS_NM}`;
        const data = await cachedFetchJson(url, storageKey, SK_CONFIG.PLANE_FETCH_MS);
        const now = Date.now();
        const validHexes = new Set();
        if (data.ac) {
            data.ac.forEach(p => {
                if (!p.lat || !p.lon) return;
                const hex = p.hex;
                validHexes.add(hex);
                SK_STATE.planes[hex] = {
                    hex: hex,
                    callsign: p.flight ? p.flight.trim() : (p.r || p.hex),
                    lat: p.lat,
                    lon: p.lon,
                    alt_ft: p.alt_geom || p.alt_baro || 0,
                    last_update: now
                };
            });
        }
        Object.keys(SK_STATE.planes).forEach(k => {
            if (!validHexes.has(k) && (now - SK_STATE.planes[k].last_update > 15000)) delete SK_STATE.planes[k];
        });
    } catch (e) { console.error('Plane Fetch Error', e); }
}

// ----- Plotting -----
function initPlots() {
    const COMPASS_VALS = [];
    const COMPASS_TEXT = [];
    const DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    for (let i = 0; i < 16; i++) { COMPASS_VALS.push(i * 22.5); COMPASS_TEXT.push(DIRS[i] + "<br>" + (i*22.5) + "°"); }
    const RECT_VALS = [...COMPASS_VALS, 360];
    const RECT_TEXT = [...COMPASS_TEXT, "N<br>360°"];

    const beamStart = 90 - (SK_CONFIG.BEAM_WIDTH_DEG / 2);
    const pBeam = { type: 'scatterpolar', mode: 'lines', r: Array(100).fill(beamStart), theta: Array.from({length:100}, (_,i)=>i*3.6), fill: 'toself', fillcolor: 'rgba(0,255,0,0.1)', line: {width:0}, name: 'Beam', hoverinfo: 'skip' };
    const rBeam = { type: 'scatter', mode: 'lines', x: [0, 360, 360, 0], y: [beamStart, beamStart, 90, 90], fill: 'toself', fillcolor: 'rgba(0,255,0,0.1)', line: {width:0}, name: 'Beam', hoverinfo: 'skip' };

    let pTerrain = {}, rTerrain = {};
    if (SK_STATE.horizon.az.length > 0) {
        const h = SK_STATE.horizon;
        const pAz = [...h.az, ...h.az.slice().reverse()];
        const pEl = [...h.alt, ...new Array(h.az.length).fill(0)];
        pTerrain = { type: 'scatterpolar', mode: 'lines', r: pEl, theta: pAz, fill: 'toself', fillcolor: 'rgba(128,128,128,0.3)', line: {color:'#888', width:1}, name: 'Terrain', hoverinfo:'skip' };
        rTerrain = { type: 'scatter', mode: 'lines', x: h.az, y: h.alt, fill: 'tozeroy', fillcolor: 'rgba(128,128,128,0.3)', line: {color:'#888', width:1}, name: 'Terrain', hoverinfo:'skip' };
    }

    const common = {
        template: "plotly_dark", paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
        margin: { t: 40, b: 60, l: 40, r: 40 }, font: { family: "monospace", color: "#eee" },
        showlegend: true, legend: { orientation: 'h', y: -0.15, font: {color: "#eee"} }
    };

    const pLayout = {
        ...common, title: '',
        polar: {
            radialaxis: { range: [90, 0], showgrid: true, gridcolor: '#444' },
            angularaxis: { rotation: 90, direction: "clockwise", gridcolor: '#444', tickmode: 'array', tickvals: COMPASS_VALS, ticktext: COMPASS_TEXT },
            bgcolor: 'rgba(0,0,0,0)'
        }
    };

    const rLayout = {
        ...common, title: '',
        xaxis: { range: [0,360], title: 'Azimuth', gridcolor: '#444', tickmode: 'array', tickvals: RECT_VALS, ticktext: RECT_TEXT },
        yaxis: { range: [0,90], title: 'Elevation', gridcolor: '#444' }
    };

    const data = SK_STATE.horizon.az.length ? [pBeam, pTerrain] : [pBeam];
    const dataR = SK_STATE.horizon.az.length ? [rBeam, rTerrain] : [rBeam];

    Plotly.newPlot('polar', data, pLayout, {responsive: true, displayModeBar: false});
    Plotly.newPlot('rect', dataR, rLayout, {responsive: true, displayModeBar: false});

    SK_STATE.plotInitialized = true;
}

function updatePlotTraces(sats, ac) {
    if (!SK_STATE.plotInitialized) return;
    const PRIORITY_GROUPS = ['Aircraft', 'STARLINK', 'MUOS'];
    const COLORS = { 'Aircraft': '#ff0000', 'STARLINK': '#00ffff', 'MUOS': '#ff00ff', 'GPS': '#ffff00', 'ONEWEB': '#00ff00', 'OTHER': '#888888' };

    const groups = {};
    PRIORITY_GROUPS.forEach(k => groups[k] = {az:[], el:[], txt:[]});
    const makeLabel = (name, dist) => `${name} (${dist.toFixed(1)} km)`;

    [...ac, ...sats].forEach(obj => {
        const g = obj.group || 'Aircraft';
        if (!groups[g]) groups[g] = {az:[], el:[], txt:[]};
        groups[g].az.push(obj.az);
        groups[g].el.push(obj.el);
        groups[g].txt.push(makeLabel(obj.name, obj.dist));
    });

    const pTraces = [], rTraces = [];
    const allKeys = [...PRIORITY_GROUPS, ...Object.keys(groups).filter(k => !PRIORITY_GROUPS.includes(k)).sort()];

    allKeys.forEach(g => {
        const d = groups[g];
        if (!d || d.az.length === 0) return;
        const color = COLORS[g] || COLORS['OTHER'];
        const baseSize = g === 'Aircraft' ? 18 : (g === 'MUOS' ? 10 : 6);
        const size = (g === 'Aircraft') ? baseSize : Math.max(2, Math.round(baseSize * 0.75));

        if (g === 'Aircraft') {
            const planeChars = d.az.map(() => '✈');
            pTraces.push({ type: 'scatterpolar', mode: 'text', name: g, showlegend: false, r: d.el, theta: d.az, text: planeChars, textfont: { size, color }, hovertext: d.txt, hoverinfo: 'text' });
            rTraces.push({ type: 'scatter', mode: 'text', name: g, showlegend: false, x: d.az, y: d.el, text: planeChars, textfont: { size, color }, hovertext: d.txt, hoverinfo: 'text' });
            const legendMarkerSize = Math.max(8, Math.round(size/2));
            pTraces.push({ type: 'scatterpolar', mode: 'markers', name: g, showlegend: true, visible: 'legendonly', r: [90], theta: [0], marker: { color, symbol: 'circle', size: legendMarkerSize, opacity: 0.9 }, hoverinfo: 'skip' });
            rTraces.push({ type: 'scatter', mode: 'markers', name: g, showlegend: true, visible: 'legendonly', x: [0], y: [0], marker: { color, symbol: 'circle', size: legendMarkerSize, opacity: 0.9 }, hoverinfo: 'skip' });
        } else {
            const markerSymbol = (g === 'STARLINK') ? 'star' : 'circle';
            const markerOpacity = 0.75;
            const def = { mode: 'markers', name: g, text: d.txt, marker: { color, symbol: markerSymbol, size, opacity: markerOpacity } };
            pTraces.push({ ...def, type: 'scatterpolar', r: d.el, theta: d.az });
            rTraces.push({ ...def, type: 'scatter', x: d.az, y: d.el });
        }
    });

    const staticCnt = SK_STATE.horizon.az.length ? 2 : 1;
    const pDiv = document.getElementById('polar');
    const rDiv = document.getElementById('rect');
    Plotly.react('polar', pDiv.data.slice(0, staticCnt).concat(pTraces), pDiv.layout);
    Plotly.react('rect', rDiv.data.slice(0, staticCnt).concat(rTraces), rDiv.layout);
}

// ----- Core math & update loop -----
function updateMathLoop() {
    const now = new Date();
    const utcStr = now.toISOString().split('.')[0].replace('T', ' ') + ' UTC';
    const tzOffsetHours = Math.round(SK_CONFIG.OBSERVER.lon / 15);
    const obsLocal = new Date(now.getTime() + tzOffsetHours * 3600 * 1000);
    const obsStr = obsLocal.toISOString().split('.')[0].replace('T', ' ');
    const signObs = tzOffsetHours >= 0 ? '+' : '';
    const pad = (n) => n.toString().padStart(2, '0');
    const u = now;
    const userStr = `${u.getFullYear()}-${pad(u.getMonth()+1)}-${pad(u.getDate())} ${pad(u.getHours())}:${pad(u.getMinutes())}:${pad(u.getSeconds())}`;
    const userOffset = -u.getTimezoneOffset() / 60; const signUser = userOffset >= 0 ? '+' : '';
    document.getElementById('clock-utc').innerText = utcStr;
    document.getElementById('clock-obs').innerText = `${obsStr} (UTC${signObs}${tzOffsetHours})`;
    document.getElementById('clock-user').innerText = `${userStr} (UTC${signUser}${userOffset})`;

    const gmst = satellite.gstime(now);
    const obs = { latitude: SK_CONFIG.OBSERVER.lat*Math.PI/180, longitude: SK_CONFIG.OBSERVER.lon*Math.PI/180, height: SK_CONFIG.OBSERVER.alt };

    const visSats = [], visPlanes = [];
    let blockSats = 0, blockPlanes = 0;

    SK_STATE.satRecords.forEach(s => {
        const pv = satellite.propagate(s, now);
        if (!pv.position) return;
        const ecf = satellite.eciToEcf(pv.position, gmst);
        const look = satellite.ecfToLookAngles(obs, ecf);
        const az = look.azimuth * 180 / Math.PI;
        const el = look.elevation * 180 / Math.PI;
        const dist = look.rangeSat;
        if (el > getHorizonLimit(az)) visSats.push({name: s.name, az, el, dist, group: s.group});
        else if (el > -10) blockSats++;
    });

    Object.values(SK_STATE.planes).forEach(p => {
        const alt_km = p.alt_ft * 0.0003048;
        const pos = satellite.geodeticToEcf({ longitude: p.lon * Math.PI/180, latitude: p.lat * Math.PI/180, height: alt_km });
        const look = satellite.ecfToLookAngles(obs, pos);
        const az = look.azimuth * 180 / Math.PI;
        const el = look.elevation * 180 / Math.PI;
        const dist = look.rangeSat;
        if (el > (getHorizonLimit(az) - 0.5)) visPlanes.push({ name: p.callsign, az: az, el: el, dist: dist, group: 'Aircraft' });
        else blockPlanes++;
    });

    document.getElementById('count-sat').innerText = visSats.length;
    document.getElementById('blocked-sat').innerText = `(${blockSats} hidden)`;
    document.getElementById('count-plane').innerText = visPlanes.length;
    document.getElementById('blocked-plane').innerText = `(${blockPlanes} hidden)`;

    updatePlotTraces(visSats, visPlanes);
}

// ----- Initialization -----
async function init() {
    try {
        console.log('[SYSTEM] Initializing...');
        if (!runtimeCheck()) return;
        await Promise.all([fetchTLEs(), fetchHorizon()]);
        fetchPlanes();
        initPlots();
        setInterval(updateMathLoop, SK_CONFIG.MATH_UPDATE_MS);
        setInterval(fetchPlanes, SK_CONFIG.PLANE_FETCH_MS);
        setInterval(fetchTLEs, SK_CONFIG.TLE_FETCH_MS);
        console.log('[SYSTEM] Loop Started.');
    } catch (e) {
        showBanner('Initialization error: ' + (e && e.message ? e.message : String(e)), true);
        console.error(e);
    }
}

// expose for debugging
window.Skyrfi = { config: SK_CONFIG, state: SK_STATE, fetchHorizon, fetchTLEs, fetchPlanes, init };

// Auto-start when script loaded (defer ensures DOM exists)
init();
