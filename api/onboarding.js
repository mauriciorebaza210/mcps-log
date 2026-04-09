const { createClient } = require('@supabase/supabase-js');
const { encrypt, decrypt, validateToken } = require('./_utils/security');

// Environment variables (provided via Vercel Dashboard)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GAS_URL = process.env.GAS_URL;
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

module.exports = async (req, res) => {
  // ── CORS ────────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Auth Check ──────────────────────────────────────────────────────────────
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
      case 'get_status':
        return await handleGetStatus(user, res);
      case 'save_info':
        return await handleSaveInfo(user, req.body, res);
      case 'save_contract':
        return await handleSaveContract(user, req.body, res);
      case 'submit':
        return await handleFullSubmit(user, req.body, res);
      case 'list_pending':
        return await handleListPending(user, res);
      case 'approve':
        return await handleApprove(user, req.body, token, res);
      case 'get_contract_template':
        return await handleGetContractTemplate(res);
      case 'update_contract_template':
        return await handleUpdateContractTemplate(user, req.body, res);
      default:
        return res.status(400).json({ ok: false, error: 'Invalid action' });
    }
  } catch (error) {
    console.error(`Error in ${action}:`, error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleGetStatus(user, res) {
  const { data, error } = await supabase
    .from('onboarding_submissions')
    .select('*')
    .eq('username', user.username)
    .single();

  if (error && error.code !== 'PGRST116') throw error;

  // Redact sensitive data - only return completion flags
  const statusLabels = {
    info_completed: !!data?.encrypted_pii,
    contract_completed: !!data?.contract_signed_at,
    status: data?.status || 'not_started',
    w9_uploaded: !!data?.w9_url
  };

  return res.status(200).json({ ok: true, status: statusLabels });
}

async function handleSaveInfo(user, body, res) {
  const { pii, w9_url } = body;
  if (!pii) return res.status(400).json({ ok: false, error: 'Missing PII' });

  const encrypted = encrypt(JSON.stringify(pii), ENCRYPTION_SECRET);

  const { error } = await supabase
    .from('onboarding_submissions')
    .upsert({
      username: user.username,
      encrypted_pii: encrypted,
      w9_url: w9_url,
      updated_at: new Date()
    });

  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function handleSaveContract(user, body, res) {
  const { error } = await supabase
    .from('onboarding_submissions')
    .update({
      contract_signed_at: new Date(),
      status: 'pending_review',
      updated_at: new Date()
    })
    .eq('username', user.username);

  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function handleFullSubmit(user, body, res) {
  const { info, w9, signature } = body;
  if (!info || !w9 || !signature) {
    return res.status(400).json({ ok: false, error: 'Missing required onboarding data' });
  }

  // 1. Encrypt PII
  const encrypted = encrypt(JSON.stringify(info), ENCRYPTION_SECRET);

  // 2. Handle W-9 Upload (Base64 to Supabase Storage)
  let w9Url = null;
  if (w9.startsWith('data:')) {
    const base64Data = w9.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = `${user.username}_w9_${Date.now()}.pdf`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('w9-forms')
      .upload(fileName, buffer, { contentType: 'application/pdf', upsert: true });

    if (uploadError) throw new Error('W-9 Upload failed: ' + uploadError.message);
    
    // Get public URL
    const { data: urlData } = supabase.storage.from('w9-forms').getPublicUrl(fileName);
    w9Url = urlData.publicUrl;
  } else {
    w9Url = w9; // Already a URL
  }

  // 3. Update Submission Record
  const { error } = await supabase
    .from('onboarding_submissions')
    .upsert({
      username: user.username,
      encrypted_pii: encrypted,
      w9_url: w9Url,
      signature: signature,
      status: 'pending_review',
      updated_at: new Date()
    });

  if (error) throw error;
  return res.status(200).json({ ok: true });
}

async function handleListPending(user, res) {
  if (!user.roles.includes('admin') && !user.roles.includes('manager')) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const { data, error } = await supabase
    .from('onboarding_submissions')
    .select('*')
    .neq('status', 'approved')
    .neq('status', 'in_progress');

  if (error) throw error;

  // Decrypt names for admin overview
  const pending = data.map(item => {
    let name = item.username;
    let details = {};
    try {
      details = JSON.parse(decrypt(item.encrypted_pii, ENCRYPTION_SECRET));
      name = details.full_name || item.username;
    } catch (e) {}
    return { 
      username: item.username, 
      display_name: name,
      status: item.status,
      submitted_at: item.updated_at,
      w9_url: item.w9_url,
      pii: {
        email: details.email,
        phone: details.phone
      }
    };
  });

  return res.status(200).json({ ok: true, pending });
}

async function handleApprove(user, body, adminToken, res) {
  if (!user.roles.includes('admin') && !user.roles.includes('manager')) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const { target_username } = body;
  if (!target_username) return res.status(400).json({ ok: false, error: 'Missing username' });

  // 1. Update GAS First (Single Source of Truth for Roles)
  try {
    const gasRes = await fetch(GAS_URL, {
      method: 'POST',
      body: JSON.stringify({
        action: 'update_user',
        secret: 'mcps_webhook_2026',
        token: adminToken,
        username: target_username,
        roles: ['trainee'],
        active: true
      })
    });

    const gasData = await gasRes.json();
    if (!gasData.ok) {
      return res.status(500).json({ ok: false, error: 'Bridge failed: ' + (gasData.error || 'Unknown error') });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Failed to connect to GAS Bridge.' });
  }

  // 2. Update Supabase
  const { error } = await supabase
    .from('onboarding_submissions')
    .update({ 
      status: 'approved', 
      approved_at: new Date(),
      approved_by: user.username 
    })
    .eq('username', target_username);

  if (error) throw error;

  return res.status(200).json({ ok: true });
}

async function handleGetContractTemplate(res) {
  const { data, error } = await supabase
    .from('mcps_config')
    .select('value')
    .eq('id', 'contract_template')
    .single();

  const defaultTemplate = `
    <div class="contract-doc">
      <h2 style="text-align:center">INDEPENDENT CONTRACTOR AGREEMENT</h2>
      <p>This Agreement is made between <strong>Mission Custom Pool Solutions</strong> ("Company") and the contractor signed below ("Contractor").</p>
      
      <h3>1. SCOPE OF SERVICES</h3>
      <p>Contractor agrees to perform professional pool maintenance, including chemical balancing, equipment inspection, and cleaning at assigned customer locations.</p>
      
      <h3>2. COMPENSATION</h3>
      <p>Company agrees to pay Contractor the base rate of <strong>$[[PAY_RATE]]</strong> per completed service stop. Payments are processed weekly based on verified service logs.</p>
      
      <h3>3. PROFESSIONAL STANDARDS</h3>
      <ul style="padding-left:1.5rem">
        <li>Maintain a professional appearance and courteous attitude.</li>
        <li>Arrive punctually for all scheduled stops.</li>
        <li>Communicate any pool issues or equipment failures immediately via the portal.</li>
        <li>Protect customer property and ensure gates are locked upon departure.</li>
      </ul>

      <h3>4. NON-DISCLOSURE</h3>
      <p>Contractor agrees to keep all customer lists, route details, and company pricing confidential. Contractor shall not solicit Company clients for side agreements.</p>

      <h3>5. TERMINATION</h3>
      <p>This agreement is at-will. Either party may terminate this relationship with 14 days written notice for any reason.</p>
      
      <p style="margin-top:2rem;font-size:0.9rem;color:#666">By signing below, you acknowledge you are an Independent Contractor responsible for your own taxes (1099) and insurance.</p>
    </div>
  `;

  return res.status(200).json({ ok: true, template: data?.value?.html || defaultTemplate });
}

async function handleUpdateContractTemplate(user, body, res) {
  if (!user.roles.includes('admin')) return res.status(403).json({ ok: false });
  const { html } = body;

  const { error } = await supabase
    .from('mcps_config')
    .upsert({ id: 'contract_template', value: { html }, updated_at: new Date() });

  if (error) throw error;
  return res.status(200).json({ ok: true });
}
