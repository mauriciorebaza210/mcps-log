// Sample I-9 fill test — mirrors the portal's generateAndReviewI9() logic exactly
// Run: node test-i9-fill.js
// Output: test-i9-output.pdf

const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Sample employee data (US citizen — simplest case)
const SAMPLE_CITIZEN = {
  first_name: 'John',
  middle_initial: 'A',
  last_name: 'Smith',
  other_last_names: 'N/A',
  dob: '1990-03-15',          // input format yyyy-mm-dd → converted to mm/dd/yyyy
  email: 'john.smith@example.com',
  phone: '(555) 867-5309',
  address_line1: '1234 Maple Street',
  address_line2: 'Apt 2B',
  address_city: 'Phoenix',
  address_state: 'AZ',
  address_zip: '85001',
  ssn_full: '123456789',
  citizenship_status: 'citizen',   // CB_1
  uscis_number: '',
  work_authorization_expiration: '',
  i94_number: '',
  foreign_passport: '',
  foreign_passport_country: '',
  signature_name: 'John A Smith',
};

// Sample LPR (Lawful Permanent Resident)
const SAMPLE_LPR = {
  first_name: 'Maria',
  middle_initial: 'G',
  last_name: 'Lopez',
  other_last_names: 'N/A',
  dob: '1985-07-22',
  email: 'maria.lopez@example.com',
  phone: '(602) 555-1234',
  address_line1: '5678 Oak Avenue',
  address_line2: '',
  address_city: 'Scottsdale',
  address_state: 'AZ',
  address_zip: '85251',
  ssn_full: '987654321',
  citizenship_status: 'lawful_permanent_resident',  // CB_3
  uscis_number: 'A012345678',
  work_authorization_expiration: '',
  i94_number: '',
  foreign_passport: '',
  foreign_passport_country: '',
  signature_name: 'Maria G Lopez',
};

// Sample Alien Authorized to Work
const SAMPLE_ALIEN = {
  first_name: 'Carlos',
  middle_initial: 'R',
  last_name: 'Mendez',
  other_last_names: 'N/A',
  dob: '1995-11-08',
  email: 'carlos.mendez@example.com',
  phone: '(480) 555-9876',
  address_line1: '9012 Pine Road',
  address_line2: '',
  address_city: 'Tempe',
  address_state: 'AZ',
  address_zip: '85281',
  ssn_full: '456789123',
  citizenship_status: 'alien_authorized',  // CB_4
  uscis_number: '',
  work_authorization_expiration: '2027-12-31',
  i94_number: '98765432100',
  foreign_passport: '',
  foreign_passport_country: '',
  signature_name: 'Carlos R Mendez',
};

function dateToMmddyyyy(value) {
  if (!value) return '';
  const parts = String(value).split('-');
  if (parts.length === 3) return parts[1] + '/' + parts[2] + '/' + parts[0];
  return value;
}

function todayMmddyyyy() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return mm + '/' + dd + '/' + d.getFullYear();
}

function setPdfText(form, name, value) {
  if (value === undefined || value === null || value === '') return;
  try {
    const field = form.getField(name);
    if (field.setText) field.setText(String(value));
    else if (field.select) field.select(String(value));
    console.log(`  ✓ Set "${name}" = "${value}"`);
  } catch(e) {
    console.log(`  ✗ FAILED "${name}" — ${e.message}`);
  }
}

function checkPdfBox(form, name) {
  try {
    form.getCheckBox(name).check();
    console.log(`  ✓ Checked box "${name}"`);
  } catch(e) {
    try {
      form.getField(name).check();
      console.log(`  ✓ Checked field "${name}"`);
    } catch(_e) {
      console.log(`  ✗ FAILED checkbox "${name}" — ${e.message}`);
    }
  }
}

async function listPdfFields() {
  const rawPdf = fs.readFileSync(path.join(__dirname, 'i-9.pdf'));
  const pdfDoc = await PDFDocument.load(rawPdf);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  console.log('\n=== ALL I-9 PDF FIELD NAMES ===');
  fields.forEach(f => {
    const type = f.constructor.name;
    console.log(`  [${type}] "${f.getName()}"`);
  });
  console.log(`=== Total: ${fields.length} fields ===\n`);
}

async function fillI9(fields, outputPath) {
  const rawPdf = fs.readFileSync(path.join(__dirname, 'i-9.pdf'));
  const pdfDoc = await PDFDocument.load(rawPdf);
  const form = pdfDoc.getForm();

  console.log('\n--- Filling fields ---');
  setPdfText(form, 'Last Name (Family Name)', fields.last_name);
  setPdfText(form, 'First Name Given Name', fields.first_name);
  setPdfText(form, 'Employee Middle Initial (if any)', fields.middle_initial);
  setPdfText(form, 'Employee Other Last Names Used (if any)', fields.other_last_names || 'N/A');
  setPdfText(form, 'Address Street Number and Name', fields.address_line1);
  setPdfText(form, 'Apt Number (if any)', fields.address_line2);
  setPdfText(form, 'City or Town', fields.address_city);
  setPdfText(form, 'State', fields.address_state);
  setPdfText(form, 'ZIP Code', fields.address_zip);
  setPdfText(form, 'Date of Birth mmddyyyy', dateToMmddyyyy(fields.dob));
  setPdfText(form, 'Employees E-mail Address', fields.email);
  setPdfText(form, 'Telephone Number', fields.phone);

  if (fields.citizenship_status === 'citizen') checkPdfBox(form, 'CB_1');
  if (fields.citizenship_status === 'noncitizen_national') checkPdfBox(form, 'CB_2');
  if (fields.citizenship_status === 'lawful_permanent_resident') {
    checkPdfBox(form, 'CB_3');
    setPdfText(form, '3 A lawful permanent resident Enter USCIS or ANumber', fields.uscis_number);
  }
  if (fields.citizenship_status === 'alien_authorized') {
    checkPdfBox(form, 'CB_4');
    setPdfText(form, 'Exp Date mmddyyyy', dateToMmddyyyy(fields.work_authorization_expiration));
    setPdfText(form, 'USCIS ANumber', fields.uscis_number);
    setPdfText(form, 'Form I94 Admission Number', fields.i94_number);
    const passportCombo = [fields.foreign_passport, fields.foreign_passport_country].filter(Boolean).join(' / ');
    if (passportCombo) setPdfText(form, 'Foreign Passport Number and Country of IssuanceRow1', passportCombo);
  }

  const ssnRaw = fields.ssn_full.substring(0, 9); // PDF field maxLength=9, no dashes
  const signatureText = fields.signature_name + ' (e-signed)';
  const dateText = todayMmddyyyy();

  setPdfText(form, 'US Social Security Number', ssnRaw);
  setPdfText(form, 'Signature of Employee', signatureText);
  setPdfText(form, "Today's Date mmddyyy", dateText);

  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  form.updateFieldAppearances(helveticaFont);
  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, pdfBytes);
  console.log(`\n  → Saved: ${outputPath}`);
}

async function main() {
  await listPdfFields();

  console.log('\n========================================');
  console.log('SAMPLE 1: US Citizen — John A Smith');
  console.log('========================================');
  await fillI9(SAMPLE_CITIZEN, path.join(__dirname, 'test-i9-citizen.pdf'));

  console.log('\n========================================');
  console.log('SAMPLE 2: Lawful Permanent Resident — Maria G Lopez');
  console.log('========================================');
  await fillI9(SAMPLE_LPR, path.join(__dirname, 'test-i9-lpr.pdf'));

  console.log('\n========================================');
  console.log('SAMPLE 3: Alien Authorized to Work — Carlos R Mendez');
  console.log('========================================');
  await fillI9(SAMPLE_ALIEN, path.join(__dirname, 'test-i9-alien.pdf'));

  console.log('\nDone. Open the 3 PDF files to verify field placement.');
}

main().catch(console.error);
