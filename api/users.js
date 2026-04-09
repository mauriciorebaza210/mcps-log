const { createClient } = require('@supabase/supabase-js');
const { validateToken } = require('./_utils/security');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GAS_URL = process.env.GAS_URL;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth Check
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split(' ')[1];
  const user = await validateToken(token, GAS_URL);

  if (!user) {
    return res.status(401).json({ ok: false, error: 'Unauthorized: Invalid token' });
  }

  const { action } = req.method === 'GET' ? req.query : req.body;

  try {
    switch (action) {
      case 'list_users':
        return await handleListUsers(res);
      case 'create_user':
        return await handleCreateUser(user, req.body, res);
      case 'update_user':
        return await handleUpdateUser(user, req.body, res);
      default:
        return res.status(400).json({ ok: false, error: 'Invalid action' });
    }
  } catch (error) {
    console.error(`Error in users api [${action}]:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};

async function handleListUsers(res) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('name', { ascending: true });

  if (error) throw error;
  return res.status(200).json({ ok: true, users: data });
}

async function validateToken(token, gasUrl) {
  if (!token || !gasUrl) return null;
  try {
    const res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'validate_token', token })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data : null;
  } catch (e) {
    console.error('Token validation error:', e);
    return null;
  }
}

async function handleCreateUser(admin, body, res) {
  if (!admin.roles.includes('admin')) {
    return res.status(403).json({ ok: false, error: 'Forbidden: Admin only' });
  }

  const { username, name, roles, password, available_days, pay_rate } = body;
  if (!username || !name) return res.status(400).json({ ok: false, error: 'Missing required fields' });

  // Note: We are not handling 'password' here yet as Auth is still in GAS.
  // In Phase 2, we would hash and store the password in Supabase Auth.

  const { error } = await supabase
    .from('profiles')
    .insert({
      username: username.toLowerCase(),
      name,
      roles,
      available_days,
      pay_rate: parseFloat(pay_rate) || 0,
      active: true
    });

  if (error) {
    if (error.code === '23505') return res.status(400).json({ ok: false, error: 'Username already exists.' });
    throw error;
  }

  return res.status(200).json({ ok: true });
}

async function handleUpdateUser(admin, body, res) {
  if (!admin.roles.includes('admin') && !admin.roles.includes('manager')) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const { username, fields } = body;
  if (!username || !fields) return res.status(400).json({ ok: false, error: 'Missing data' });

  // Clean data
  const updateData = { ...fields };
  if (updateData.pay_rate) updateData.pay_rate = parseFloat(updateData.pay_rate) || 0;

  const { error } = await supabase
    .from('profiles')
    .update(updateData)
    .eq('username', username);

  if (error) throw error;
  return res.status(200).json({ ok: true });
}
