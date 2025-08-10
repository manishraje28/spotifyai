/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
// index.js
// Required packages: express, axios, dotenv, cors
// Run `npm install express axios dotenv cors`

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import 'dotenv/config'; // To load environment variables from a .env file
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const port = 8000; // Must match the port in your Redirect URI

// --- Environment Variables ---
// Your .env file should be in the same directory (spotifyai/)
// SPOTIFY_CLIENT_ID=your_spotify_client_id
// SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
// REDIRECT_URI=http://127.0.0.1:8000/callback
// GEMINI_API_KEY=your_gemini_api_key

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI, GEMINI_API_KEY, GEMINI_MODEL } = process.env;
const GEMINI_MODEL_NAME = GEMINI_MODEL || 'gemini-1.5-flash'; // default to free/cheaper model

// Gemini client (only if key present)
let genAI = null;
if (GEMINI_API_KEY) {
    try {
        genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // lazy model fetch in function
    } catch (e) {
        console.warn('Failed to init Gemini client:', e.message);
    }
} else {
    console.warn('GEMINI_API_KEY not set. AI command interpretation will use fallback heuristics.');
}

// --- Middleware ---
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(express.json()); // To parse JSON bodies in POST requests

// --- In-memory storage for tokens (for simplicity) ---
// In a production app, you would store this securely (e.g., in a database).
let accessToken = '';
let refreshToken = '';


// --- Helper Functions ---

/**
 * Generates a random string containing numbers and letters
 * @param  {number} length The length of the string
 * @return {string} The generated string
 */
const generateRandomString = (length) => {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
};

// --- Authentication Routes ---

/**
 * 1. The Login Route: Kicks off the authentication process.
 * Redirects the user to Spotify's authorization page.
 */
app.get('/login', (req, res) => {
    const state = generateRandomString(16);
    // The 'scope' defines the permissions we are asking for.
    const scope = [
        'user-read-private',
        'user-read-email',
        'user-modify-playback-state', // To control playback (play, pause, skip)
        'user-read-playback-state',   // To read the current playback state
        'streaming',                  // Required for Web Playback SDK
        'playlist-read-private'       // To read user's private playlists
    ].join(' ');

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
    authUrl.searchParams.append('scope', scope);
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.append('state', state);

    res.redirect(authUrl.toString());
});

/**
 * 2. The Callback Route: Handles the redirect from Spotify.
 * Exchanges the authorization code for an access token.
 */
app.get('/callback', async (req, res) => {
    const code = req.query.code || null;

    try {
        const response = await axios({
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            data: new URLSearchParams({
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')),
            },
        });

        accessToken = response.data.access_token;
        refreshToken = response.data.refresh_token;

        console.log('Successfully authenticated!');
        console.log('Access Token:', accessToken);
        
        // You can redirect to a simple success page or send a message
        res.send('Authentication successful! You can now close this tab and send commands to the /command endpoint.');

    } catch (error) {
        console.error('Error getting tokens:', error.response ? error.response.data : error.message);
        res.status(500).send('Error during authentication.');
    }
});


// --- AI Command Processing Route ---

/**
 * 3. The Command Route: Receives natural language and acts on it.
 */
app.post('/command', async (req, res) => {
    const { command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'Command is required.' });
    }
    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated. Please visit /login first.' });
    }

    try {
        // --- Step 3a: Use Gemini to interpret the command ---
        const interpretation = await getActionFromGemini(command);
        console.log('Gemini Interpretation:', interpretation);

        // --- Step 3b: Execute the action based on Gemini's response ---
        const result = await executeSpotifyAction(interpretation);

        // We only want to send back a confirmation, not the entire axios response object.
        res.json({ success: true, message: "Command executed successfully." });

    } catch (error) {
        console.error('Error processing command:', error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: 'Failed to process command.', details: error.message });
    }
});


// --- Gemini and Spotify Logic ---

/**
 * Uses the Gemini API to turn a natural language command into a structured JSON object.
 * @param {string} userCommand The command from the user, e.g., "Play the next song"
 * @returns {Promise<object>} A JSON object with 'action' and 'parameters'
 */
async function getActionFromGemini(userCommand) {
    // If no Gemini key, immediately fallback to heuristic parsing.
    if (!genAI) {
        return heuristicInterpret(userCommand);
    }

    const systemInstructions = `You translate natural language Spotify control commands into a compact JSON.
Return ONLY JSON with: {"action": string, "parameters": object}.
Allowed actions: play, pause, next, previous, search_and_play, play_artist_top_tracks, play_my_playlist.
Rules: No commentary. No markdown fences. If searching, choose type among track, artist, playlist (best guess).
`;

    const examples = [
        { c: 'Pause the current song', j: { action: 'pause', parameters: {} } },
        { c: 'Play the next track', j: { action: 'next', parameters: {} } },
        { c: 'Search for a Lofi playlist and play it', j: { action: 'search_and_play', parameters: { query: 'Lofi', type: 'playlist' } } },
        { c: 'Play something by Tame Impala', j: { action: 'search_and_play', parameters: { query: 'Tame Impala', type: 'artist' } } },
        { c: 'Play the top songs by AR Rahman', j: { action: 'play_artist_top_tracks', parameters: { artistName: 'AR Rahman' } } },
        { c: 'Play relaxing music', j: { action: 'search_and_play', parameters: { query: 'relaxing music', type: 'playlist' } } },
        { c: 'Play the song Hotel California', j: { action: 'search_and_play', parameters: { query: 'Hotel California', type: 'track' } } },
        { c: 'Play my workout playlist', j: { action: 'play_my_playlist', parameters: { playlistName: 'workout' } } }
    ];

    const prompt = [
        systemInstructions,
        ...examples.map(e => `Command: "${e.c}"
${JSON.stringify(e.j)}`),
        `Command: "${userCommand}"`
    ].join('\n\n');

    try {
        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        const result = await model.generateContent(prompt);
        const raw = (result?.response?.text() || '').trim();
        const cleaned = raw
            .replace(/^```json/i, '')
            .replace(/^```/, '')
            .replace(/```$/g, '')
            .trim();
        const parsed = safeJson(cleaned);
        if (parsed && parsed.action) return sanitizeInterpretation(parsed);
        // Attempt secondary extraction if model wrapped JSON in text
        const extracted = extractJsonFromText(raw);
        if (extracted && extracted.action) return sanitizeInterpretation(extracted);
        return heuristicInterpret(userCommand);
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
            console.warn('Gemini quota/rate limit hit. Falling back to heuristic interpretation.');
        } else {
            console.warn('Gemini error, using heuristic fallback:', err.message);
        }
        return heuristicInterpret(userCommand);
    }
}

function safeJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

function extractJsonFromText(text) {
    const match = text.match(/\{[\s\S]*\}$/m);
    if (!match) return null;
    return safeJson(match[0]);
}

function sanitizeInterpretation(obj) {
    const allowed = new Set(['play','pause','next','previous','search_and_play','play_artist_top_tracks','play_my_playlist']);
    if (!allowed.has(obj.action)) return { action: 'play', parameters: {} };
    // Basic parameter whitelisting
    const p = obj.parameters || {};
    switch (obj.action) {
        case 'search_and_play':
            return { action: obj.action, parameters: { query: String(p.query || '' ).slice(0,120), type: pickType(p.type) } };
        case 'play_artist_top_tracks':
            return { action: obj.action, parameters: { artistName: String(p.artistName || p.artist || '').slice(0,80) } };
        case 'play_my_playlist':
            return { action: obj.action, parameters: { playlistName: String(p.playlistName || p.name || '').slice(0,80) } };
        default:
            return { action: obj.action, parameters: {} };
    }
}

function pickType(t) {
    const allowed = ['track','artist','playlist'];
    if (allowed.includes(t)) return t;
    return 'track';
}

// Heuristic fallback if AI unavailable or fails
function heuristicInterpret(command) {
    const c = command.toLowerCase();
    if (/pause|stop/.test(c)) return { action: 'pause', parameters: {} };
    if (/next|skip/.test(c)) return { action: 'next', parameters: {} };
    if (/previous|back/.test(c)) return { action: 'previous', parameters: {} };
    if (/play (my )?\w+ playlist/.test(c)) {
        const m = c.match(/play (?:my )?(.+?) playlist/);
        if (m) return { action: 'play_my_playlist', parameters: { playlistName: m[1].trim() } };
    }
    if (/top songs by|top tracks by|play top songs of/.test(c)) {
        const m = c.match(/(?:by|of) (.+)$/);
        if (m) return { action: 'play_artist_top_tracks', parameters: { artistName: m[1].trim() } };
    }
    if (/play /.test(c)) {
        // Attempt to extract after 'play'
        const m = c.match(/play (.+)/);
        if (m) {
            const query = m[1].replace(/^(the )/, '').trim();
            // Guess type by simple keywords
            let type = 'track';
            if (/playlist/.test(query)) type = 'playlist';
            else if (/ by /.test(query)) type = 'track';
            return { action: 'search_and_play', parameters: { query: query.replace(/ playlist/, ''), type } };
        }
    }
    // Default generic
    return { action: 'play', parameters: {} };
}


/**
 * Executes the corresponding Spotify API call based on the interpreted action.
 * @param {object} interpretation The JSON object from Gemini.
 * @returns {Promise<any>} The result from the Spotify API call.
 */
async function executeSpotifyAction(interpretation) {
    const { action, parameters } = interpretation;
    const spotifyApiBase = 'https://api.spotify.com/v1';

    const headers = { 'Authorization': `Bearer ${accessToken}` };

    switch (action) {
        case 'play':
            return axios.put(`${spotifyApiBase}/me/player/play`, {}, { headers });
        case 'pause':
            return axios.put(`${spotifyApiBase}/me/player/pause`, {}, { headers });
        case 'next':
            return axios.post(`${spotifyApiBase}/me/player/next`, {}, { headers });
        case 'previous':
            return axios.post(`${spotifyApiBase}/me/player/previous`, {}, { headers });

        case 'search_and_play': {
            const { query, type } = parameters;
            // 1. Search for the item
            const searchRes = await axios.get(`${spotifyApiBase}/search`, {
                headers,
                params: { q: query, type: type, limit: 1 }
            });
            
            const items = searchRes.data[`${type}s`].items;
            if (items.length === 0) throw new Error(`No ${type} found for query: ${query}`);
            
            const itemUri = items[0].uri;

            // 2. Play the item
            let playData = {};
            if (type === 'track') {
                playData = { uris: [itemUri] };
            } else {
                playData = { context_uri: itemUri };
            }

            return axios.put(`${spotifyApiBase}/me/player/play`, playData, { headers });
        }

        case 'play_artist_top_tracks': {
            const { artistName } = parameters;
            // 1. Search for the artist to get their ID
            const searchRes = await axios.get(`${spotifyApiBase}/search`, {
                headers,
                params: { q: artistName, type: 'artist', limit: 1 }
            });

            if (searchRes.data.artists.items.length === 0) {
                throw new Error(`Artist not found: ${artistName}`);
            }
            const artistId = searchRes.data.artists.items[0].id;

            // 2. Get the artist's top tracks
            const topTracksRes = await axios.get(`${spotifyApiBase}/artists/${artistId}/top-tracks`, {
                headers,
                params: { market: 'US' } // Market is required
            });

            const trackUris = topTracksRes.data.tracks.map(track => track.uri);
            if (trackUris.length === 0) throw new Error(`No top tracks found for ${artistName}`);

            // 3. Play the top tracks
            return axios.put(`${spotifyApiBase}/me/player/play`, {
                uris: trackUris
            }, { headers });
        }

        case 'play_my_playlist': {
            const { playlistName } = parameters;
            // 1. Get the user's playlists
            const playlistsRes = await axios.get(`${spotifyApiBase}/me/playlists`, {
                headers,
                params: { limit: 50 } // Get up to 50 playlists
            });

            const playlists = playlistsRes.data.items;
            
            // 2. Find the playlist by name (case-insensitive, partial match)
            const playlist = playlists.find(p => p.name.toLowerCase().includes(playlistName.toLowerCase()));

            if (!playlist) {
                throw new Error(`Playlist '${playlistName}' not found in your library.`);
            }

            // 3. Play the found playlist
            return axios.put(`${spotifyApiBase}/me/player/play`, {
                context_uri: playlist.uri
            }, { headers });
        }

        default:
            throw new Error(`Unknown action: ${action}`);
    }
}


// --- Start the server ---
app.listen(port, () => {
    console.log(`AI Spotify Assistant server listening at http://127.0.0.1:${port}`);
    console.log(`To start, open your browser to http://127.0.0.1:${port}/login`);
});
