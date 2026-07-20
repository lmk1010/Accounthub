import axios from 'axios';
import db from './backend/src/config/database.js';

(async () => {
  const pool = db;
  const [rows] = await pool.execute('SELECT uuid, name, credentials FROM providers WHERE provider_type = ? LIMIT 1', ['claude-offical']);
  if (!rows.length) {
    console.log('No Claude Official account found');
    return;
  }

  const provider = rows[0];
  const creds = JSON.parse(provider.credentials);
  console.log('Provider:', provider.name);
  console.log('UUID:', provider.uuid);

  try {
    const response = await axios.get('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Authorization': `Bearer ${creds.access_token}`,
        'anthropic-beta': 'oauth-2025-04-20'
      }
    });
    console.log('\nAPI Response:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.error('Error:', error.response?.status, error.response?.data || error.message);
  }

  process.exit(0);
})();
