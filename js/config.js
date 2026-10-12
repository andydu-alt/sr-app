// Where the login and sync server lives. The app pages are served from GitHub Pages; Netlify hosts login and sync.
export const NETLIFY_SITE = 'https://sr-app-andydu.netlify.app';
export const MAIN_APP_URL = 'https://andydu-alt.github.io/sr-app/';

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const onNetlify = location.hostname.endsWith('.netlify.app');
export const API_BASE = local || onNetlify ? '' : NETLIFY_SITE;
export const IDENTITY_URL = API_BASE + '/.netlify/identity';
export const SYNC_URL = API_BASE + '/.netlify/functions/sync';
export const IS_NETLIFY_COPY = onNetlify;
