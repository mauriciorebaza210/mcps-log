const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const usersToMigrate = [
  {"username":"mau","name":"Mauricio Rebaza","roles":["admin"],"active":true,"available_days":"","pay_rate":0},
  {"username":"tony","name":"Tony Siller","roles":["technician","admin","trainee"],"active":true,"available_days":"Monday,Tuesday,Wednesday,Thursday,Friday,Saturday","pay_rate":0},
  {"username":"chuy","name":"Chuy Silva","roles":["technician","admin"],"active":true,"available_days":"Monday,Tuesday,Wednesday,Thursday,Friday,Saturday","pay_rate":0},
  {"username":"eduardogarcia","name":"Eduardo Garcia","roles":["technician","trainee"],"active":true,"available_days":"","pay_rate":0}
];

async function migrate() {
  console.log('--- Starting Migration ---');
  for (const user of usersToMigrate) {
    console.log(`Migrating @${user.username}...`);
    const { error } = await supabase
      .from('profiles')
      .upsert({
        username: user.username,
        name: user.name,
        roles: user.roles.join(','),
        active: user.active,
        available_days: user.available_days,
        pay_rate: user.pay_rate
      });
    
    if (error) {
      console.error(`Error migrating @${user.username}:`, error.message);
    } else {
      console.log(`Successfully migrated @${user.username}`);
    }
  }
  console.log('--- Migration Complete ---');
}

migrate();
