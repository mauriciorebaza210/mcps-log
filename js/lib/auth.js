// ══════════════════════════════════════════════════════════════════════════════
// AUTH — login, logout, session, role checks
// Depends on: constants.js (SEC, ROLE_PAGES), api.js (api)
// Uses globals: _s (session), showApp, _defaultLandingPage_ (defined here)
// ══════════════════════════════════════════════════════════════════════════════

function doLogin() {
  const u = document.getElementById('u').value.trim();
  const p = document.getElementById('p').value.trim();
  const btn = document.getElementById('btn-login');
  const err = document.getElementById('lerr');
  if (!u||!p){showLErr('Enter username and password.');return;}
  btn.disabled=true; btn.textContent='Signing in...'; err.style.display='none';
  api({action:'login',username:u,password:p}).then(res=>{
    if(res.ok){
      const roles = res.roles || [res.role || 'technician'];
      const pages = unionPages_(roles);
      _s = {token:res.token,name:res.name,roles,pages};
      localStorage.setItem('mcps_s',JSON.stringify(_s));
      const deep = sessionStorage.getItem('mcps_deep') || _defaultLandingPage_();
      sessionStorage.removeItem('mcps_deep');
      showApp(deep);
    } else {
      showLErr(res.error||'Login failed.');
      btn.disabled=false; btn.textContent='Sign In';
    }
  }).catch(()=>{showLErr('Network error.');btn.disabled=false;btn.textContent='Sign In';});
}

function showLErr(m){const el=document.getElementById('lerr');el.textContent=m;el.style.display='block';}

function doLogout(){if(_s)api({action:'logout',secret:SEC,token:_s.token}).catch(()=>{});_s=null;localStorage.removeItem('mcps_s');location.hash='';location.reload();}

function unionPages_(roles) {
  const set = new Set();
  const order = ['home','onboarding','live_map','service_log','crm','inventory','quotes','training','admin'];
  roles.forEach(r=>{(ROLE_PAGES[r]||[]).forEach(p=>set.add(p));});
  return order.filter(p=>set.has(p));
}

function hasRole(role){return _s&&(_s.roles||[]).includes(role);}
function isAdmin(){return hasRole('admin')||hasRole('manager');}
// Technicians, leads, and trainees land directly on the Hub; everyone else on Home
function _defaultLandingPage_(){ return (hasRole('technician')||hasRole('lead')||hasRole('trainee')) ? 'live_map' : 'home'; }
