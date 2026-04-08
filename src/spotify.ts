import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';

const CLIENT_ID = '340c6d71228044d3855e07d354408b91';
const SCOPES = 'user-read-playback-state user-read-currently-playing';

export interface CurrentlyPlaying {
  trackName: string;
  artistName: string;
  albumArt: string;
  isPlaying: boolean;
}

// Generates a random alphanumeric string for the code verifier
function generateRandomString(length: number): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Generates the code challenge based on the verifier
async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, [...new Uint8Array(digest)]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const LOCAL_REDIRECT_URI = 'http://127.0.0.1:14214/callback';

export async function redirectToSpotifyAuth(): Promise<boolean> {
  try {
    const verifier = generateRandomString(128);
    const challenge = await generateCodeChallenge(verifier);

    localStorage.setItem('spotify_verifier', verifier);

    const args = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: SCOPES,
      redirect_uri: LOCAL_REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge
    });

    const url = `https://accounts.spotify.com/authorize?${args.toString()}`;
    console.log("Opening Spotify Auth URL:", url);
    
    // Start the local TCP listener in the Rust backend
    const authPromise = invoke<string>('start_oauth_server');

    // Open the browser
    await openUrl(url);

    // Wait for the browser to redirect and the Rust server to catch the code!
    const code = await authPromise;
    console.log("Caught authorization code:", code);
    
    if (code) {
      const success = await handleAuthCallback(code);
      console.log("Token exchange result:", success);
      return success;
    }
    return false;
  } catch (error) {
    console.error("Failed to authenticate with Spotify:", error);
    return false;
  }
}

async function handleAuthCallback(code: string): Promise<boolean> {
  const verifier = localStorage.getItem('spotify_verifier');
  if (!verifier) {
    console.error('No verifier found in localStorage');
    return false;
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: LOCAL_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier
  });

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body
    });

    if (!response.ok) {
      console.error('Failed to exchange token', await response.text());
      return false;
    }

    const data = await response.json();
    setTokens(data);
    localStorage.removeItem('spotify_verifier');
    return true;
  } catch (err) {
    console.error('Auth callback error', err);
    return false;
  }
}

function setTokens(data: any) {
  localStorage.setItem('spotify_access_token', data.access_token);
  if (data.refresh_token) {
    localStorage.setItem('spotify_refresh_token', data.refresh_token);
  }
  // Store expiration time (current time + expires_in seconds)
  const expiresAt = Date.now() + (data.expires_in * 1000);
  localStorage.setItem('spotify_expires_at', expiresAt.toString());
}

export function isConnected(): boolean {
  return !!localStorage.getItem('spotify_refresh_token');
}

export async function getValidAccessToken(): Promise<string | null> {
  let token = localStorage.getItem('spotify_access_token');
  const expiresAtStr = localStorage.getItem('spotify_expires_at');
  
  if (!token || !expiresAtStr) return null;

  const expiresAt = parseInt(expiresAtStr, 10);
  // Refresh if within 5 minutes of expiring
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    token = await refreshAccessToken();
  }

  return token;
}

export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem('spotify_refresh_token');
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID
  });

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body
    });

    if (!response.ok) {
      console.error('Failed to refresh token', await response.text());
      // If refresh fails permanently, we might want to clear tokens, but let's be safe for now
      return null;
    }

    const data = await response.json();
    setTokens(data);
    return data.access_token;
  } catch (err) {
    console.error('Refresh token error', err);
    return null;
  }
}

export async function getCurrentlyPlaying(): Promise<{ track: CurrentlyPlaying | null; error?: string }> {
  const token = await getValidAccessToken();
  if (!token) return { track: null, error: 'No valid access token' };

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.status === 204) {
      // 204 No Content means nothing is currently playing
      return { track: null };
    }

    if (response.status === 401) {
      return { track: null, error: 'Token expired or invalid (401)' };
    }

    if (!response.ok) {
      const text = await response.text();
      console.error('Failed to fetch currently playing', response.status, text);
      return { track: null, error: `API error ${response.status}` };
    }

    const data = await response.json();
    
    if (!data || !data.item) return { track: null };

    return {
      track: {
        trackName: data.item.name,
        artistName: data.item.artists.map((a: any) => a.name).join(', '),
        albumArt: data.item.album.images[0]?.url || '',
        isPlaying: data.is_playing
      }
    };
  } catch (err) {
    console.error('Error fetching currently playing', err);
    return { track: null, error: `Fetch failed: ${err}` };
  }
}

export function disconnectSpotify() {
    localStorage.removeItem('spotify_access_token');
    localStorage.removeItem('spotify_refresh_token');
    localStorage.removeItem('spotify_expires_at');
    localStorage.removeItem('spotify_verifier');
}
