/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
// index.js
// Required packages: express, axios, dotenv, cors
// Run `npm install express axios dotenv cors`

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import 'dotenv/config'; // To load environment variables from a .env file

const app = express();
const port = 8000; // Must match the port in your Redirect URI

// --- Environment Variables ---
// Your .env file should be in the same directory (spotifyai/)
// SPOTIFY_CLIENT_ID=your_spotify_client_id
// SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
// REDIRECT_URI=http://127.0.0.1:8000/callback
// GEMINI_API_KEY=your_gemini_api_key

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI, GEMINI_API_KEY } = process.env;

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
    const prompt = `
        You are an expert assistant that translates natural language commands into structured JSON objects for the Spotify API.
        Analyze the user's command and determine the correct action and any necessary parameters.

        Your response MUST be a single, valid JSON object and nothing else.

        The possible actions are:
        - "play": Resume playback.
        - "pause": Pause playback.
        - "next": Skip to the next track.
        - "previous": Skip to the previous track.
        - "search_and_play": Search for something and play the first result. Parameters: "query" (string), "type" (string, e.g., "track", "artist", "playlist").
        - "play_artist_top_tracks": Find an artist and play their top songs. Parameters: "artistName" (string).
        - "play_my_playlist": Finds and plays a playlist from the user's library. Parameters: "playlistName" (string).

        Here are some examples:

        Command: "Pause the current song"
        {"action": "pause", "parameters": {}}

        Command: "Play the next track"
        {"action": "next", "parameters": {}}

        Command: "Search for a Lofi playlist and play it"
        {"action": "search_and_play", "parameters": {"query": "Lofi", "type": "playlist"}}

        Command: "Play something by Tame Impala"
        {"action": "search_and_play", "parameters": {"query": "Tame Impala", "type": "artist"}}

        Command: "Play the top songs by AR Rahman"
        {"action": "play_artist_top_tracks", "parameters": {"artistName": "AR Rahman"}}

        Command: "Play relaxing music"
        {"action": "search_and_play", "parameters": {"query": "relaxing music", "type": "playlist"}}

        Command: "Play the song Hotel California"
        {"action": "search_and_play", "parameters": {"query": "Hotel California", "type": "track"}}

        Command: "Play my workout playlist"
        {"action": "play_my_playlist", "parameters": {"playlistName": "workout"}}

        Now, analyze this command:
        Command: "${userCommand}"
    `;
    
    // ***UPDATED***: Switched back to gemini-1.5-flash to avoid rate limits.
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await axios.post(geminiApiUrl, {
        contents: [{ parts: [{ text: prompt }] }]
    });

    // Extract and clean the JSON string from Gemini's response
    const jsonString = response.data.candidates[0].content.parts[0].text
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();
        
    return JSON.parse(jsonString);
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
