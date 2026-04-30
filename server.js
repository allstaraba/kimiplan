'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { body, validationResult } = require('express-validator');

const { aiClient: anthropic, PROVIDER } = require('./ai-client');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');
const { Packer } = require('docx');
const { buildDocx } = require('./docx-builder');
const XLSX = require('xlsx');
const { injectBoilerplate, buildGoalSummaryTable } = require('./plan-boilerplate');
const { postProcessDocxBuffer } = require('./docx-postprocess');
const { REAUTH_SYSTEM_PROMPT } = require('./reauth-prompt');
const { runBackup, latestBackup, BACKUP_DIR } = require('./backup');
const db = require('./db');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-5';
const REQUIRE_CLINICAL_REVIEW = process.env.REQUIRE_CLINICAL_REVIEW === '1';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TEMP_UPLOADS_DIR = path.join(DATA_DIR, 'uploads', 'temp');

if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required. Set it in your .env file.');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error('[FATAL] ANTHROPIC_API_KEY or OPENAI_API_KEY is required.');
  process.exit(1);
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });

console.log(`[startup] AI provider: ${PROVIDER.toUpperCase()}`);
console.log(`[startup] Using model: ${CLAUDE_MODEL}`);
console.log(`[startup] Clinical review gate: ${REQUIRE_CLINICAL_REVIEW ? 'ENABLED' : 'DISABLED'}`);

const app = express();

// ─── SECURITY MIDDLEWARE ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Let the React app handle its own CSP in production
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || false, // false = same-origin only unless explicitly set
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const generateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Generation limit reached. Please wait a few minutes.' },
});

app.use('/api/login', authLimiter);
app.use('/api/', apiLimiter);
app.use('/api/generate', generateLimiter);
app.use('/api/revise', generateLimiter);
app.use('/api/chat', generateLimiter);

// ─── STATIC FILES ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'client', 'dist')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    req.token = token;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'Admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function bcbaMiddleware(req, res, next) {
  if (!['Admin', 'BCBA'].includes(req.user.role)) {
    return res.status(403).json({ error: 'BCBA or Admin access required' });
  }
  next();
}

// ─── VALIDATION HELPER ────────────────────────────────────────────────────────
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg });
  }
  next();
}

// ─── ACTIVITY LOGGER ──────────────────────────────────────────────────────────
function logActivity(userId, username, action, targetType = null, targetId = null, details = null) {
  try {
    db.prepare(
      'INSERT INTO activity_log (user_id, username, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, username, action, targetType, targetId, details);
  } catch (e) {
    console.error('[activity_log] Failed to log:', e.message);
  }
}

// ─── UPLOAD CONFIG ────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/jpg'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG and JPG images are accepted'));
    }
  },
});

const clientStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOADS_DIR, 'clients', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
  }
});
const uploadClient = multer({ storage: clientStorage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── GENERATION JOB TRACKING ──────────────────────────────────────────────────
// Keyed by unique jobId (not userId) so concurrent jobs don't clobber each other
const generationJobs = new Map(); // jobId -> { status, section, total, label, planId, clientName, error, startedAt, userId }

function setJob(jobId, data) {
  generationJobs.set(jobId, { ...generationJobs.get(jobId), ...data });
}
function clearJob(jobId) {
  generationJobs.delete(jobId);
}

// ─── TEXT HELPERS ─────────────────────────────────────────────────────────────
function stripAIPreamble(text) {
  const markers = ['# ABA Treatment Plan', '## ABA Treatment Plan', 'ABA Treatment Plan'];
  for (const marker of markers) {
    const idx = text.indexOf(marker);
    if (idx > 0) return text.slice(idx);
  }
  return text;
}

function fixMasteryCriteria(text) {
  let ferbFixed = 0;
  let nonFerbFixed = 0;
  const fixed = text.split('\n').map(line => {
    if (!/Goal Statement/i.test(line)) return line;
    const isFerb = /\(FERB\)/i.test(line);
    const correct = isFerb ? '90' : '80';
    const wrong = isFerb ? '80' : '90';
    const updated = line.replace(
      new RegExp(`\\bin ${wrong}% of opportunities`, 'i'),
      `in ${correct}% of opportunities`
    );
    if (updated !== line) {
      isFerb ? ferbFixed++ : nonFerbFixed++;
    }
    return updated;
  }).join('\n');
  return { text: fixed, ferbFixed, nonFerbFixed };
}

function formatClientInfoForPrompt(clientInfo) {
  const sections = [
    { title: 'CLIENT INFORMATION', keys: ['client_full_name','date_of_birth','date_of_assessment','date_of_reassessment'] },
    { title: 'FAMILY STRUCTURE', keys: ['parent_guardian_name','parent_guardian_phone','parent_guardian_email','father_caregiver_name','siblings','marital_status','individuals_living_in_home','cultural_legal_issues','environmental_factors','safety_concerns'] },
    { title: 'MEDICATIONS', keys: ['medications'] },
    { title: 'MEDICAL HISTORY', keys: ['pcp_name','pcp_phone','allergies','medical_concerns','dietary_restrictions','surgery_history','er_history','family_mental_health_history'] },
    { title: 'BIRTH HISTORY', keys: ['pregnancy_complications','birth_concerns','delivery_method','weeks_gestation'] },
    { title: 'SCHOOL PLACEMENT', keys: ['school_name','school_setting','grade','school_schedule','school_hours_per_week'] },
    { title: 'ABA HISTORY', keys: ['prior_aba_history'] },
    { title: 'OTHER SERVICES', keys: ['other_mental_health_services','other_services_slp_ot'] },
    { title: 'COORDINATION OF CARE', keys: ['coordination_providers','major_life_changes'] },
    { title: 'OBSERVATION DETAILS', keys: ['observation_date','observation_start_time','observation_end_time','observation_location','individuals_present'] },
    { title: 'RECOMMENDED HOURS', keys: ['hours_97153','hours_97155','hours_97156','hours_97151','authorization_start_date','authorization_end_date','service_location'] },
    { title: 'PROVIDER INFORMATION', keys: ['supervising_bcba_name','supervising_bcba_credentials','supervising_bcba_phone'] },
    { title: 'EMERGENCY CONTACTS', keys: ['emergency_contact_name','emergency_contact_phone'] },
  ];

  const keyLabels = {
    client_full_name: 'Client Full Name', date_of_birth: 'Date of Birth',
    date_of_assessment: 'Date of Assessment', date_of_reassessment: 'Date of Reassessment',
    parent_guardian_name: 'Parent/Guardian Name', parent_guardian_phone: 'Parent/Guardian Phone',
    parent_guardian_email: 'Parent/Guardian Email', father_caregiver_name: 'Father/Caregiver Name',
    siblings: 'Siblings', marital_status: 'Marital Status',
    individuals_living_in_home: 'Individuals Living in Home', cultural_legal_issues: 'Cultural/Legal Issues',
    environmental_factors: 'Environmental Factors', safety_concerns: 'Safety Concerns',
    medications: 'Medications', pcp_name: 'PCP Name', pcp_phone: 'PCP Phone',
    allergies: 'Allergies', medical_concerns: 'Medical Concerns',
    dietary_restrictions: 'Dietary Restrictions', surgery_history: 'Surgery History',
    er_history: 'ER/Hospitalization History', family_mental_health_history: 'Family Mental Health History',
    pregnancy_complications: 'Pregnancy Complications', birth_concerns: 'Birth/Neonatal Concerns',
    delivery_method: 'Delivery Method', weeks_gestation: 'Weeks Gestation',
    school_name: 'School Name', school_setting: 'School Setting', grade: 'Grade',
    school_schedule: 'School Schedule', school_hours_per_week: 'School Hours Per Week',
    prior_aba_history: 'Prior ABA History', other_mental_health_services: 'Other Mental Health Services',
    other_services_slp_ot: 'Other Services (SLP/OT)', coordination_providers: 'Coordination Providers',
    major_life_changes: 'Major Life Changes', observation_date: 'Observation Date',
    observation_start_time: 'Observation Start Time', observation_end_time: 'Observation End Time',
    observation_location: 'Observation Location', individuals_present: 'Individuals Present',
    hours_97153: '97153 Direct BT Hours/Week', hours_97155: '97155-GT BCBA Hours/Week',
    hours_97156: '97156-GT Parent Training Hours/Week', hours_97151: '97151 Assessment Hours',
    authorization_start_date: 'Authorization Start Date', authorization_end_date: 'Authorization End Date',
    service_location: 'Service Location', supervising_bcba_name: 'Supervising BCBA Name',
    supervising_bcba_credentials: 'BCBA Credentials', supervising_bcba_phone: 'BCBA Phone',
    emergency_contact_name: 'Emergency Contact Name', emergency_contact_phone: 'Emergency Contact Phone',
  };

  const lines = ['=== VERIFIED CLIENT INFORMATION (confirmed by BCBA) ===', ''];
  for (const section of sections) {
    const sectionLines = [];
    for (const key of section.keys) {
      const val = clientInfo[key];
      if (val !== null && val !== undefined && String(val).trim() !== '') {
        sectionLines.push(`${keyLabels[key] || key}: ${val}`);
      }
    }
    if (sectionLines.length > 0) {
      lines.push(`${section.title}:`);
      lines.push(...sectionLines);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── CLINICAL EXPORT GATE ─────────────────────────────────────────────────────
function hasIncompletePlaceholders(text) {
  if (!text) return true;
  return /\[TO BE COMPLETED(?: BY BCBA)?\]/gi.test(text);
}

function checkClinicalReadiness(planId, planText) {
  if (!REQUIRE_CLINICAL_REVIEW) return { ready: true };

  const plan = db.prepare('SELECT clinical_review_complete FROM plan_history WHERE id = ?').get(planId);
  if (!plan || !plan.clinical_review_complete) {
    return { ready: false, reason: 'Clinical review is not marked complete for this plan.' };
  }
  if (hasIncompletePlaceholders(planText)) {
    return { ready: false, reason: 'Plan still contains incomplete placeholders ([TO BE COMPLETED BY BCBA]). Please complete all clinical sections before exporting.' };
  }
  return { ready: true };
}

// ─── GENERATION INSTRUCTIONS (RESTRICTED SCOPE) ───────────────────────────────
// The AI only writes Sections 1–14. Everything else is [TO BE COMPLETED BY BCBA].
const GEN = {
  S1: {
    id: 'S1',
    label: 'Client Info & Narrative (sections 1–9)',
    instruction: `Generate ONLY sections 1 through 9 of the ABA treatment plan:

1. "ABA Treatment Plan" title header
2. ☐ Review checkbox: "☐ I reviewed the ABA treatment plan requirements before submitting this report."
3. Client Information table — 2-column table with EXACTLY these rows, in this order:
   - Name
   - Date of Birth
   - Date of Initial Assessment
   - Date of Current Reassessment
   - Parent/Guardian Contact: write the guardian name, phone, and email in ONE single cell, formatted as "[Name] | [Phone] | [Email]". Use values from the notes if present, otherwise [TO BE COMPLETED BY BCBA] for each missing piece.
4. Biopsychosocial Information: Current Family Structure table (include Environmental Factors and Safety Concerns rows), Medications table, Medical History table including Birth History, School Placement table
5. History of ABA Services table
6. Other Mental Health Services table and Other Services table
7. Coordination of Care — write '[COORDINATION_CARE_LANGUAGE]' in the bordered coordination text cell. Then the provider table. Write '[COORDINATION_NOTES_LANGUAGE]' in the coordination notes cell.
8. Major Life Changes table
9. Narrative — ONE unified bordered table (do not split into multiple tables). The single table must contain, in order:
   Row 1 (merged header): "Narrative"
   Row 2 (merged sub-header): "Direct Observation"
   Row 3 (5 columns, header): Date | Start Time | End Time | Location | Individuals Present
   Row 4 (5 columns, data): [observation date/time/location/people]
   Row 5 (merged paragraph): The observation paragraph describing what was observed during the session
   Row 6 (merged sub-header): "Clinical Narrative"
   Row 7 (merged cell): All four domain paragraphs in ONE cell, separated by blank lines and bold sub-headers: **Communication**, **Social**, **Adaptive/Safety Skills**, **Challenging Behaviors**

CRITICAL: If any information is missing from the BCBA notes, write exactly [TO BE COMPLETED BY BCBA]. Do not invent facts, names, dates, scores, or behaviors.

STOP after section 9. Do NOT write Strengths/Challenges, assessments, goals, BIPs, or any later sections.`,
  },

  S2: {
    id: 'S2',
    label: 'Assessments & Summary (sections 10–14)',
    instruction: `Sections 1–9 have been written above. Continue — do not repeat anything.

Generate ONLY sections 10 through 14:

10. Strengths/Challenges/Severity Level — 2-column pipe table. Do NOT include a "Strengths/Challenges/Severity Level" header row and do NOT include any blank row. Do NOT split Strengths, Challenges, and Severity into separate rows — all three MUST be in ONE right-column cell per domain, separated by <br><br>.

Output EXACTLY in this format (4 rows total, one per domain):
| Language/Communication | Strengths: [text]<br><br>Challenges: [text]<br><br>Severity Level: ☐ Mild ☐ Moderate ☑ Severe |
| Social Skills | Strengths: [text]<br><br>Challenges: [text]<br><br>Severity Level: ☐ Mild ☐ Moderate ☑ Severe |
| Adaptive/Self-Care | Strengths: [text]<br><br>Challenges: [text]<br><br>Severity Level: ☐ Mild ☐ Moderate ☑ Severe |
| Challenging Behaviors | Strengths: [text]<br><br>Challenges: [text]<br><br>Severity Level: ☐ Mild ☐ Moderate ☑ Severe |

Do NOT use "Strengths" and "Challenges" as column headers. Do NOT include Vineland scores in this section.

11. Standardized Assessment — Vineland-3. Generate in this EXACT order:
a) Bordered table: header "Standardized Assessment", second row "Name of Standardized Assessment conducted: Vineland Adaptive Behavior Scales, Third Edition (Vineland-3)"
b) Bordered table: header "Vineland Adaptive Behavior Scales, Third Edition (Vineland-3)", second row with the boilerplate intro
c) Single 3-column row: Form: [form name] | Full Name of Rater: [name] | Date: [date]
d) Bordered table cell containing EXACTLY: [INSERT VINELAND ABC/DOMAIN AND SUBDOMAIN SCORE SUMMARY GRAPHIC HERE]
e) Maladaptive Behavior Score Summary table: Type | Scaled Score | Qualitative Descriptor with rows Internalizing, Externalizing, Critical Items
f) Critical Items detail if available
g) Clinical Interpretation paragraph in bordered table

If any Vineland data is missing from the notes, write [TO BE COMPLETED BY BCBA]. Do not invent scores.

12. Criterion-Referenced Assessment:
a) Header table
b) Boilerplate intro
c) Bordered table cell containing EXACTLY: [INSERT VB-MAPP/ABLLS-R SCORING GRID GRAPHIC HERE]
d) Assessment narrative — all domains in one cell, no bold headings, smooth transitions

If assessment data is missing, write [TO BE COMPLETED BY BCBA].

12b. Current Problem Areas / Skills Deficits — Required compliance section. Insert a bordered table immediately after the Criterion-Referenced Assessment and before the Goal Objective Summary. Include a header row and one content row for EACH of the following 11 domains — write 1–3 client-specific sentences describing the deficit based on the BCBA notes and assessment data. If no deficit exists, write "Within normal limits." Do NOT skip or omit any domain:
(a) Cognitive/Pre-academic Skills
(b) Language/Communication Skills
(c) Reduction of Interfering Behaviors
(d) Severe Behavior
(e) Safety Skills
(f) Social Skills
(g) Play and Leisure
(h) Independent Living/Self-Help
(i) Community Integration
(j) Coping and Tolerance
(k) Other

If deficits are not described in the notes, write [TO BE COMPLETED BY BCBA].

13. Goal Objective Summary — write ONLY: [GOAL_SUMMARY_TABLE]

14. Response to Treatment/Authorization Summary — write "N/A — Initial Treatment Plan" for initial plans.

STOP after section 14. Do NOT write goals, BIPs, behavior reduction, parent training, generalization, fading, crisis, recommendations, or provider information.`,
  },

  S3A: {
    id: 'S3A',
    label: 'Skill Acquisition Goals',
    instruction: `Sections 1–14 have been written above. Continue — do not repeat anything.

Generate ONLY section 14: Skill Acquisition Goals.

Follow the SKILL ACQUISITION GOALS LAYOUT and GOAL SELECTION & CLINICAL PRIORITIZATION HIERARCHY rules from your instructions. Key requirements:
- Begin with "Skill Acquisition Goals" as a shaded merged header row in the first goal table
- Organize by domain: Language/Communication, Social, Adaptive/Self-Care
- Each domain begins with a shaded domain header row flush with the first goal
- Each goal is its own 2-column bordered table with 6 rows: MNR, Goal Statement, Baseline, Date of Introduction, Projected Mastery, Progress Data: N/A
- Goal number appears ONLY in the Goal Statement row label (e.g., "14. Goal Statement:")
- MNR rows must be FULLY POPULATED with correct deficit letter and minimum 2 remediation bullets
- Sequential numbering across all domains without restarting
- No standalone "Goal N" rows
- No hygiene/dressing/toileting as SA goals
- Include FERB goals with (FERB) prefix and 90% mastery
- Use assessment-anchored goal selection and tier hierarchy
- Use inclusive communication modality language for all manding goals

STOP after Skill Acquisition Goals. Do NOT write BIPs, behavior reduction goals, parent training, or any later sections.`,
  },

  S3B: {
    id: 'S3B',
    label: 'Behavior Intervention Plans',
    instruction: `Sections 1–14 and all Skill Acquisition Goals have been written above. Continue — do not repeat anything.

Generate ONLY section 15: Behavior Intervention Plans.

Follow the BIP STRUCTURE and BIP TABLE STRUCTURE rules from your instructions. Key requirements:
- BIPs appear immediately after SA goals, BEFORE Behavior Reduction Goals
- NO standalone BIP section header table
- Generate BIPs in order: Social Negative → Social Positive → Automatic Reinforcement (Sensory) only if sensory-maintained behaviors are identified
- Each BIP is ONE single 2-column bordered table containing ALL rows
- BIP title row = full-width merged cell: "Behavior Intervention Plan: [Function Name]"
- BIP Date row = full-width merged cell
- "Quantitative Baseline Data" has NO colon after it
- Write out complete FERB goal statements verbatim in the FERB row
- Each intervention is its own paragraph within the cell
- Physical guidance is NEVER a consequence strategy
- Standard de-escalation protocol for all BIPs

STOP after BIPs. Do NOT write behavior reduction goals, parent training, or any later sections.`,
  },

  S3C: {
    id: 'S3C',
    label: 'Behavior Reduction & Parent Training',
    instruction: `Sections 1–15 have been written above. Continue — do not repeat anything.

Generate ONLY sections 16–17: Behavior Reduction Goals and Parent or Caregiver Training.

For Behavior Reduction Goals:
- First BR goal table must include "Behavior Reduction Goals" as shaded merged Row 0
- Each goal is its own 2-column bordered table
- Use specific count targets: "[Client] will reduce instances of [behavior] to [0 or specific number] instances per day across four consecutive weeks in the presence of two people and in two settings"
- NEVER write "decrease by X% from baseline"
- NO MNR rows in BR goals
- Sequential numbering continuing from SA goals

For Parent/Caregiver Training:
- First PT goal table must include "Parent or Caregiver Training" as shaded merged Row 0
- Always 2+ goals
- NO MNR rows in PT goals
- Include dressing/hygiene/toileting caregiver training goal if applicable

STOP after Parent Training. Do NOT write generalization, fading, discharge, crisis, recommendations, or provider information.`,
  },

  S3D1: {
    id: 'S3D1',
    label: 'Generalization, Fading & Discharge',
    instruction: `Sections 1–17 have been written above. Continue — do not repeat anything.

Generate ONLY sections 18–20: Generalization Plan, Transition and Fading Plan, and Discharge Criteria.

For Generalization Plan:
- ONE single bordered table containing ALL content
- Include Generalization Protocol and Maintenance Protocol standard boilerplate

For Transition and Fading Plan:
- Transition Intro table with [FADING_PLAN_INTRO]
- Transition table: N/A | N/A | N/A
- Fading Rationale table with both paragraphs
- Phase Criteria table with EXACTLY 3 columns: Phase | Service Levels | Status
- Phase 1 goals selected from this plan's highest-priority goals
- Phases 2–4 goals are NEW, ORIGINAL long-term goals — not copied from the plan

For Discharge Criteria:
- ONE bordered table with header "Discharge Criteria"
- Use the exact standard list

STOP after Discharge Criteria. Do NOT write crisis plan, recommendations, provider information, consent, or telehealth checklist.`,
  },

  S3D2: {
    id: 'S3D2',
    label: 'Crisis, Recommendations, Provider & Consent',
    instruction: `Sections 1–20 have been written above. Continue — do not repeat anything.

Generate ONLY sections 21–26: Crisis Plan, Recommendations for ABA Services, Place of Service Justification, Provider Information, Attestation, Clinical Reviewer, Consent, and Maryland Medicaid Telehealth Readiness Checklist.

For Crisis Plan:
- Crisis Intro table with standard language
- Emergency & Clinical Contacts table (include all required contacts)
- Crisis Protocol table with individualized protocols for each safety-critical behavior
- Post-Crisis Procedures in one cell

For Recommendations:
- Medical Necessity table with standard language
- CPT codes table with exactly 4 columns and correct modifiers (97156-GT/U2)
- Anticipated Schedule table matching 97153 hours

For Place of Service Justification:
- 2-column table with shaded header
- Individualize every row using BCBA notes

For Provider Information:
- 2-column table with all required rows
- Attestation table with standard language
- Clinical Reviewer table with exact labels: "Clinical Reviewer Name:" and "Clinical Reviewer Credentials:"

For Consent:
- NO Consent header row
- Begin directly with consent text and exactly 3 signature lines

For Telehealth Checklist:
- Standalone table separate from Consent
- Bold "Yes" for every answer

This is the final section. Generate everything completely.`,
  },
};

// Placeholder footer for all sections the AI does NOT write
const CLINICAL_PLACEHOLDER = `

## Skill Acquisition Goals

[TO BE COMPLETED BY BCBA]

## Behavior Intervention Plans

[TO BE COMPLETED BY BCBA]

## Behavior Reduction Goals

[TO BE COMPLETED BY BCBA]

## Parent or Caregiver Training Goals

[TO BE COMPLETED BY BCBA]

## Generalization Plan

[TO BE COMPLETED BY BCBA]

## Transition and Fading Plan

[TO BE COMPLETED BY BCBA]

## Crisis Plan

[TO BE COMPLETED BY BCBA]

## Recommendations for ABA Services

[TO BE COMPLETED BY BCBA]

## Provider Information

[TO BE COMPLETED BY BCBA]

## Consent

[TO BE COMPLETED BY BCBA]

## Maryland Medicaid Telehealth Readiness Checklist

[TELEHEALTH_CHECKLIST]
`;


// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// ─── SETUP (first-run only) ───────────────────────────────────────────────────

app.post('/api/setup',
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const { username, password } = req.body;
      const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
      if (anyUser) return res.status(403).json({ error: 'Setup already complete' });

      const hash = await bcrypt.hash(password, 10);
      const result = db.prepare(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
      ).run(username, hash, 'Admin');

      const token = jwt.sign(
        { id: result.lastInsertRowid, username, role: 'Admin' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      db.prepare('INSERT INTO sessions (user_id, token) VALUES (?, ?)').run(result.lastInsertRowid, token);
      res.json({ token, user: { id: result.lastInsertRowid, username, role: 'Admin' } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/setup', (req, res) => {
  try {
    const anyUser = db.prepare('SELECT id FROM users LIMIT 1').get();
    res.json({ needsSetup: !anyUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login',
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const { username, password } = req.body;
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });

      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'Invalid credentials' });

      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );
      db.prepare('INSERT INTO sessions (user_id, token) VALUES (?, ?)').run(user.id, token);
      res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.post('/api/logout', authMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATION STATUS ────────────────────────────────────────────────────────

app.get('/api/generate/status', authMiddleware, (req, res) => {
  // Find the most recent job for this user
  let found = null;
  for (const [jobId, job] of generationJobs) {
    if (job.userId === req.user.id) {
      if (!found || (job.startedAt && job.startedAt > found.startedAt)) {
        found = { ...job, jobId };
      }
    }
  }
  if (!found) return res.json({ status: 'idle' });
  res.json(found);
});

// ─── CLIENT INFO ──────────────────────────────────────────────────────────────

app.get('/api/client-info/:plan_id', authMiddleware, (req, res) => {
  try {
    const row = db.prepare('SELECT data FROM client_info WHERE plan_id = ?').get(req.params.plan_id);
    if (!row) return res.json({});
    res.json(JSON.parse(row.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/client-info/:plan_id', authMiddleware, (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: 'data is required' });
    db.prepare('INSERT OR REPLACE INTO client_info (plan_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run(req.params.plan_id, JSON.stringify(data));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GENERATE ROUTE (RESTRICTED TO BCBA/ADMIN, ONLY S1+S2) ────────────────────

app.post('/api/generate', authMiddleware, bcbaMiddleware, async (req, res) => {
  const jobId = `gen_${req.user.id}_${Date.now()}`;
  let keepAlive = null;
  let streamRef = null;

  const cleanup = () => {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamRef) { try { streamRef.abort(); } catch {} streamRef = null; }
  };

  try {
    const { notes, clientInfo, uploadedFileIds } = req.body;
    if (!notes) {
      cleanup();
      return res.status(400).json({ error: 'Notes are required' });
    }

    const activePrompt = db.prepare('SELECT * FROM prompt_versions WHERE is_active = 1').get();
    const systemPrompt = activePrompt ? activePrompt.text : 'You are an ABA treatment plan assistant.';

    let clientName = 'Unknown';
    if (clientInfo?.client_full_name) {
      clientName = clientInfo.client_full_name;
    } else {
      const namePatterns = [
        /(?:client(?:'?s)?(?:\s+(?:full\s+)?name)?|child(?:'?s)?(?:\s+name)?|patient(?:'?s)?(?:\s+name)?|participant(?:'?s)?(?:\s+name)?)\s*:\s*([^\n,]+)/i,
        /(?:^|\n)\s*(?:name|full name)\s*:\s*([^\n,]+)/i,
        /(?:^|\n)\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*(?:is a |was referred|presents|DOB|Date of Birth)/,
      ];
      for (const re of namePatterns) {
        const m = notes.match(re);
        if (m) {
          clientName = m[1].trim().replace(/^[_*\s]+|[_*\s]+$/g, '');
          break;
        }
      }
    }

    const baseMessage = clientInfo && Object.keys(clientInfo).length > 0
      ? `${formatClientInfoForPrompt(clientInfo)}\n=== ORIGINAL BCBA NOTES ===\n${notes}`
      : notes;

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write(': connected\n\n');

    let clientConnected = true;
    res.on('close', () => { clientConnected = false; cleanup(); });

    setJob(jobId, {
      status: 'running', section: 1, total: 7, label: GEN.S1.label,
      planId: null, clientName, error: null, startedAt: Date.now(), userId: req.user.id,
    });

    let totalChunksSent = 0;
    const send = (obj) => {
      if (!clientConnected) return;
      if (obj.type === 'chunk') totalChunksSent++;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 10000);

    const SECTION_TIMEOUT_MS = 5 * 60 * 1000;
    const callWithRetry = async (secId, messages, maxAttempts = 4) => {
      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const msgChars = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
        console.log(`[generate] ${secId} attempt ${attempt}/${maxAttempts}: ${msgChars.toLocaleString()} chars input`);

        let sectionText = '';
        try {
          await new Promise((resolve, reject) => {
            const thinkingEffort = process.env.CLAUDE_THINKING_EFFORT || '';
            const streamParams = {
              model: CLAUDE_MODEL,
              max_tokens: 32768,
              system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
              messages,
            };
            if (thinkingEffort) {
              streamParams.thinking = { type: 'adaptive' };
              streamParams.output_config = { effort: thinkingEffort };
              streamParams.temperature = 1;
            }
            const stream = anthropic.messages.stream(streamParams);
            streamRef = stream;

            const timeoutId = setTimeout(() => {
              try { stream.abort(); } catch {}
              reject(new Error(`${secId} timed out after 5 minutes`));
            }, SECTION_TIMEOUT_MS);

            let firstChunk = true;
            stream.on('text', (chunk) => {
              if (firstChunk) { console.log(`[generate] ${secId} first chunk received`); firstChunk = false; }
              sectionText += chunk;
              send({ type: 'chunk', text: chunk.replace(/<br\s*\/?>/gi, '\n') });
            });
            stream.on('finalMessage', (msg) => {
              clearTimeout(timeoutId);
              console.log(`[generate] ${secId} done. stop_reason=${msg.stop_reason} output=${sectionText.length} chars`);
              resolve();
            });
            stream.on('error', (err) => { clearTimeout(timeoutId); reject(err); });
          });

          if (sectionText.trim().length < 100) {
            throw new Error(`${secId} returned suspiciously short output (${sectionText.trim().length} chars)`);
          }
          return sectionText;
        } catch (err) {
          lastErr = err;
          const isPrematureClose = err.message === 'Premature close' || err.code === 'ERR_STREAM_PREMATURE_CLOSE';
          const isAborted = err.constructor?.name === 'APIUserAbortError' || err.message?.includes('aborted');
          const isTimeout = err.message && err.message.includes('timed out after 5 minutes');
          if ((isPrematureClose || isTimeout || isAborted) && attempt < maxAttempts) {
            const delay = attempt * 5000;
            const reason = isTimeout ? 'timeout (no response)' : 'premature close (no output)';
            console.log(`[generate] ${secId} ${reason}. Retrying in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          console.error(`[generate] ${secId} failed on attempt ${attempt}:`, err.message);
          throw err;
        }
      }
      throw lastErr;
    };

    const buildMessages = (sec, contextBlock) => {
      const clientPrefix = `You are generating a treatment plan for ${clientName}. Use ONLY "${clientName}" as the client's name throughout — do not use any other client's name.\n\n`;
      const instruction = clientPrefix + sec.instruction;
      return contextBlock
        ? [
            { role: 'user', content: baseMessage },
            { role: 'assistant', content: contextBlock },
            { role: 'user', content: instruction },
          ]
        : [{ role: 'user', content: `${baseMessage}\n\n${instruction}` }];
    };

    send({ type: 'progress', section: 1, total: 7, label: GEN.S1.label });
    setJob(jobId, { section: 1, label: GEN.S1.label });
    const s1Text = await callWithRetry(GEN.S1.id, buildMessages(GEN.S1, null));

    send({ type: 'progress', section: 2, total: 7, label: GEN.S2.label });
    setJob(jobId, { section: 2, label: GEN.S2.label });
    const s2Text = await callWithRetry(GEN.S2.id, buildMessages(GEN.S2, s1Text));

    send({ type: 'progress', section: 3, total: 7, label: GEN.S3A.label });
    setJob(jobId, { section: 3, label: GEN.S3A.label });
    const s3aText = await callWithRetry(GEN.S3A.id, buildMessages(GEN.S3A, s1Text + '\n\n' + s2Text));

    send({ type: 'progress', section: 4, total: 7, label: GEN.S3B.label });
    setJob(jobId, { section: 4, label: GEN.S3B.label });
    const s3bText = await callWithRetry(GEN.S3B.id, buildMessages(GEN.S3B, s1Text + '\n\n' + s2Text + '\n\n' + s3aText));

    send({ type: 'progress', section: 5, total: 7, label: GEN.S3C.label });
    setJob(jobId, { section: 5, label: GEN.S3C.label });
    const s3cText = await callWithRetry(GEN.S3C.id, buildMessages(GEN.S3C, s1Text + '\n\n' + s2Text + '\n\n' + s3aText + '\n\n' + s3bText));

    send({ type: 'progress', section: 6, total: 7, label: GEN.S3D1.label });
    setJob(jobId, { section: 6, label: GEN.S3D1.label });
    const s3d1Text = await callWithRetry(GEN.S3D1.id, buildMessages(GEN.S3D1, s1Text + '\n\n' + s2Text + '\n\n' + s3aText + '\n\n' + s3bText + '\n\n' + s3cText));

    send({ type: 'progress', section: 7, total: 7, label: GEN.S3D2.label });
    setJob(jobId, { section: 7, label: GEN.S3D2.label });
    const s3d2Text = await callWithRetry(GEN.S3D2.id, buildMessages(GEN.S3D2, s1Text + '\n\n' + s2Text + '\n\n' + s3aText + '\n\n' + s3bText + '\n\n' + s3cText + '\n\n' + s3d1Text));

    let fullPlanText = [s1Text, s2Text, s3aText, s3bText, s3cText, s3d1Text, s3d2Text].join('\n\n');
    console.log(`[generate] All sections complete. Total: ${fullPlanText.length} chars`);

    cleanup();
    fullPlanText = stripAIPreamble(fullPlanText);

    const { text: planTextFixed, ferbFixed, nonFerbFixed } = fixMasteryCriteria(fullPlanText);
    fullPlanText = planTextFixed;
    console.log(`[generate] Mastery criteria: ${ferbFixed} FERB goals fixed to 90%, ${nonFerbFixed} non-FERB goals fixed to 80%`);

    const planNameMatch = fullPlanText.match(/Participant Name[:\s]+([^\n\r]+)/i);
    if (planNameMatch && clientName === 'Unknown') {
      clientName = planNameMatch[1].trim().replace(/^[_*|\s]+|[_*|\s]+$/g, '');
    }
    if (clientName !== 'Unknown') {
      fullPlanText = fullPlanText.replace(/\bUnknown\b/g, clientName);
    }

    const bcbaMatch = fullPlanText.match(/(?:Supervising BCBA|BCBA Name)[:\s|]+([^\n\r|]+)/i);
    const bcbaName = bcbaMatch ? bcbaMatch[1].trim() : '[BCBA NAME]';
    const dateMatch = fullPlanText.match(/Assessment Date[:\s|]+([^\n\r|]+)/i);
    const assessmentDate = dateMatch ? dateMatch[1].trim() : '[DATE]';

    const goalCount = (fullPlanText.match(/\d+\.\s*Goal Statement:/g) || []).length;
    const correctGoalTable = buildGoalSummaryTable(goalCount);
    fullPlanText = fullPlanText.replace(
      /(##\s+Goal Objective Summary\s*\n)([\s\S]*?)(?=##\s+Response to Treatment)/i,
      (match, header) => header + '\n' + correctGoalTable + '\n\n'
    );

    const injectedPlanText = injectBoilerplate(fullPlanText, clientName, bcbaName, assessmentDate, goalCount);
    console.log(`[generate] Boilerplate injected. Raw: ${fullPlanText.length} chars → Final: ${injectedPlanText.length} chars`);

    const planInsert = db.prepare(
      'INSERT INTO plan_history (user_id, client_name, original_notes) VALUES (?, ?, ?)'
    ).run(req.user.id, clientName, notes);
    const planId = planInsert.lastInsertRowid;

    db.prepare(
      'INSERT INTO plan_revisions (plan_id, revision_number, text, feedback) VALUES (?, ?, ?, ?)'
    ).run(planId, 0, injectedPlanText, 'Initial generation (AI-assisted shell)');
    console.log(`[generate] DB save complete. plan_id=${planId}`);

    if (clientInfo && Object.keys(clientInfo).length > 0) {
      db.prepare('INSERT OR REPLACE INTO client_info (plan_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
        .run(planId, JSON.stringify(clientInfo));
    }

    if (Array.isArray(uploadedFileIds) && uploadedFileIds.length > 0) {
      const clientDir = path.join(UPLOADS_DIR, 'clients', String(planId));
      fs.mkdirSync(clientDir, { recursive: true });
      for (const f of uploadedFileIds) {
        try {
          const tempFiles = fs.readdirSync(TEMP_UPLOADS_DIR).filter(n => n.startsWith(f.fileId + '_'));
          if (tempFiles.length === 0) continue;
          const tempFilename = tempFiles[0];
          const destFilename = `${Date.now()}_${tempFilename.slice(f.fileId.length + 1)}`;
          fs.renameSync(
            path.join(TEMP_UPLOADS_DIR, tempFilename),
            path.join(clientDir, destFilename)
          );
          const ext = path.extname(f.originalName).toLowerCase();
          db.prepare(
            'INSERT INTO client_documents (plan_id, filename, original_name, file_type, file_size, uploaded_by) VALUES (?,?,?,?,?,?)'
          ).run(planId, destFilename, f.originalName, ext || f.fileType, f.fileSize || 0, req.user.id);
        } catch (e) {
          console.error(`[generate] Failed to save temp file ${f.fileId}:`, e.message);
        }
      }
    }

    if (clientConnected) {
      send({ type: 'done', plan_id: planId, client_name: clientName });
      res.end();
    }
    setJob(jobId, { status: 'done', planId, clientName });
    setTimeout(() => { if (generationJobs.get(jobId)?.status === 'done') clearJob(jobId); }, 60000);
    logActivity(req.user.id, req.user.username, 'generated_plan', 'plan', planId, clientName);

  } catch (err) {
    cleanup();
    console.error('Generate error:', err);
    setJob(jobId, { status: 'error', error: err.message });
    setTimeout(() => { if (generationJobs.get(jobId)?.status === 'error') clearJob(jobId); }, 30000);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    } catch {}
  }
});


// ─── REVISE ROUTE (BCBA/ADMIN ONLY, S1+S2 ONLY) ───────────────────────────────

app.post('/api/revise', authMiddleware, bcbaMiddleware, async (req, res) => {
  let keepAlive = null;
  let streamRef = null;

  const cleanup = () => {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamRef) { try { streamRef.abort(); } catch {} streamRef = null; }
  };

  try {
    const { plan_id, feedback } = req.body;
    if (!plan_id || !feedback) return res.status(400).json({ error: 'plan_id and feedback are required' });

    const plan = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const allRevisions = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number ASC'
    ).all(plan_id);
    if (!allRevisions.length) return res.status(404).json({ error: 'No revisions found' });

    const activePrompt = db.prepare('SELECT * FROM prompt_versions WHERE is_active = 1').get();
    const systemPrompt = activePrompt ? activePrompt.text : 'You are an ABA treatment plan assistant.';

    const clientName = plan.client_name || 'the client';

    const messages = [
      { role: 'user', content: plan.original_notes },
      { role: 'assistant', content: allRevisions[0].text },
    ];
    for (let i = 1; i < allRevisions.length; i++) {
      messages.push({ role: 'user', content: allRevisions[i].feedback });
      messages.push({ role: 'assistant', content: allRevisions[i].text });
    }
    messages.push({
      role: 'user',
      content: `You are revising a treatment plan for ${clientName}. Use ONLY "${clientName}" as the client's name throughout.\n\n${feedback}\n\nGenerate the COMPLETE revised treatment plan following all formatting and structure rules.`,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write(': connected\n\n');

    let clientConnected = true;
    res.on('close', () => { clientConnected = false; cleanup(); });

    keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

    const send = (obj) => {
      if (!clientConnected) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    let revisedText = '';
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 32768,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    streamRef = stream;

    stream.on('text', (chunk) => {
      revisedText += chunk;
      send({ type: 'chunk', text: chunk.replace(/<br\s*\/?>/gi, '\n') });
    });

    stream.on('finalMessage', async (msg) => {
      cleanup();
      const newRevisionNumber = allRevisions[allRevisions.length - 1].revision_number + 1;
      revisedText = stripAIPreamble(revisedText);

      // Enforce mastery criteria
      const { text: fixedText, ferbFixed, nonFerbFixed } = fixMasteryCriteria(revisedText);
      revisedText = fixedText;
      if (ferbFixed + nonFerbFixed > 0) {
        console.log(`[revise] Mastery criteria: ${ferbFixed} FERB goals fixed to 90%, ${nonFerbFixed} non-FERB goals fixed to 80%`);
      }

      // Full plan revision — no placeholder injection needed

      const bcbaMatch = revisedText.match(/(?:Supervising BCBA|BCBA Name)[:\s|]+([^\n\r|]+)/i);
      const bcbaName = bcbaMatch ? bcbaMatch[1].trim() : '[BCBA NAME]';
      const dateMatch = revisedText.match(/Assessment Date[:\s|]+([^\n\r|]+)/i);
      const assessmentDate = dateMatch ? dateMatch[1].trim() : '[DATE]';

      const goalCount = (revisedText.match(/\d+\.\s*Goal Statement:/g) || []).length;
      const correctGoalTable = buildGoalSummaryTable(goalCount);
      revisedText = revisedText.replace(
        /(##\s+Goal Objective Summary\s*\n)([\s\S]*?)(?=##\s+Response to Treatment)/i,
        (match, header) => header + '\n' + correctGoalTable + '\n\n'
      );

      revisedText = injectBoilerplate(revisedText, clientName, bcbaName, assessmentDate, goalCount);

      // Reset clinical review on revision
      db.prepare('UPDATE plan_history SET clinical_review_complete = 0, clinical_reviewed_by = NULL, clinical_reviewed_at = NULL WHERE id = ?').run(plan_id);

      db.prepare(
        'INSERT INTO plan_revisions (plan_id, revision_number, text, feedback) VALUES (?, ?, ?, ?)'
      ).run(plan_id, newRevisionNumber, revisedText, feedback);
      console.log(`[revise] saved revision ${newRevisionNumber} for plan_id=${plan_id}`);
      logActivity(req.user.id, req.user.username, 'revised_plan', 'plan', Number(plan_id), feedback.slice(0, 200));
      if (clientConnected) {
        send({ type: 'done', revision_number: newRevisionNumber });
        res.end();
      }
    });

    stream.on('error', (err) => {
      cleanup();
      console.error('Revise stream error:', err);
      if (clientConnected) {
        send({ type: 'error', error: err.message });
        res.end();
      }
    });

  } catch (err) {
    cleanup();
    console.error('Revise error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PLAN ROUTES ──────────────────────────────────────────────────────────────

app.get('/api/plan/:id/revisions', authMiddleware, (req, res) => {
  try {
    const revisions = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number ASC'
    ).all(req.params.id);
    res.json(revisions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/plans', authMiddleware, (req, res) => {
  try {
    const plans = db.prepare(`
      SELECT
        ph.id,
        ph.client_name,
        ph.created_at,
        ph.clinical_review_complete,
        u.username AS bcba,
        COUNT(pr.id) AS revision_count
      FROM plan_history ph
      LEFT JOIN users u ON ph.user_id = u.id
      LEFT JOIN plan_revisions pr ON pr.plan_id = ph.id
      GROUP BY ph.id
      ORDER BY ph.created_at DESC
    `).all();
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/plans/:id', authMiddleware, (req, res) => {
  try {
    const plan = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const revisions = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number ASC'
    ).all(req.params.id);
    const goals = db.prepare(
      'SELECT * FROM plan_goals WHERE plan_id = ? ORDER BY goal_number ASC'
    ).all(req.params.id);
    res.json({ ...plan, revisions, goals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/plans/:id/duplicate', authMiddleware, bcbaMiddleware, async (req, res) => {
  try {
    const original = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(req.params.id);
    if (!original) return res.status(404).json({ error: 'Plan not found' });

    const latestRevision = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number DESC LIMIT 1'
    ).get(req.params.id);

    const newPlan = db.prepare(
      'INSERT INTO plan_history (user_id, client_name, original_notes) VALUES (?, ?, ?)'
    ).run(req.user.id, `${original.client_name} (Copy)`, original.original_notes);

    const newPlanId = newPlan.lastInsertRowid;

    if (latestRevision) {
      db.prepare(
        'INSERT INTO plan_revisions (plan_id, revision_number, text, feedback) VALUES (?, ?, ?, ?)'
      ).run(newPlanId, 0, latestRevision.text, 'Duplicated from plan #' + original.id);
    }

    // Copy goals
    const originalGoals = db.prepare('SELECT * FROM plan_goals WHERE plan_id = ?').all(req.params.id);
    for (const g of originalGoals) {
      db.prepare(
        'INSERT INTO plan_goals (plan_id, goal_bank_id, domain, goal_number, goal_statement, baseline, is_ferb) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(newPlanId, g.goal_bank_id, g.domain, g.goal_number, g.goal_statement, g.baseline, g.is_ferb);
    }

    logActivity(req.user.id, req.user.username, 'duplicated_plan', 'plan', newPlanId, `original plan ${req.params.id}`);
    res.json({ plan_id: newPlanId, client_name: `${original.client_name} (Copy)` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLINICAL REVIEW GATE ─────────────────────────────────────────────────────

app.post('/api/plans/:id/clinical-review', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    const { complete } = req.body;
    const plan = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // Only the plan owner or an admin can mark clinical review
    if (plan.user_id !== req.user.id && req.user.role !== 'Admin') {
      return res.status(403).json({ error: 'Only the plan owner or an admin can mark clinical review.' });
    }

    if (complete) {
      const latestRevision = db.prepare(
        'SELECT text FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number DESC LIMIT 1'
      ).get(req.params.id);
      if (hasIncompletePlaceholders(latestRevision?.text || '')) {
        return res.status(422).json({ error: 'Cannot mark clinical review complete: plan still contains [TO BE COMPLETED BY BCBA] placeholders.' });
      }
      db.prepare(
        'UPDATE plan_history SET clinical_review_complete = 1, clinical_reviewed_by = ?, clinical_reviewed_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(req.user.id, req.params.id);
    } else {
      db.prepare(
        'UPDATE plan_history SET clinical_review_complete = 0, clinical_reviewed_by = NULL, clinical_reviewed_at = NULL WHERE id = ?'
      ).run(req.params.id);
    }

    logActivity(req.user.id, req.user.username, complete ? 'marked_clinical_complete' : 'marked_clinical_incomplete', 'plan', Number(req.params.id), null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── FILE UPLOAD ──────────────────────────────────────────────────────────────

app.post('/api/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { originalname, buffer, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let extractedText = '';

    const isPDF = buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46;
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4B;

    if (isPDF) {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      extractedText = data.text;
    } else if (ext === '.docx' || (isZip && ext !== '.zip' && ext !== '.xlsx')) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (['.xlsx', '.xls'].includes(ext)) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const parts = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
        if (csv.trim()) parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
      }
      extractedText = parts.join('\n\n');
    } else if (['.txt', '.md', '.rtf'].includes(ext)) {
      extractedText = buffer.toString('utf8');
    } else if (ext === '.zip') {
      const tmpPath = path.join(os.tmpdir(), `upload_${Date.now()}.zip`);
      fs.writeFileSync(tmpPath, buffer);
      let zip;
      try {
        zip = new AdmZip(tmpPath);
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      const entries = zip.getEntries();
      const parts = [];
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        const entryExt = path.extname(entryName).toLowerCase();
        const entryBuffer = entry.getData();
        let entryText = '';
        try {
          if (entryExt === '.docx') {
            const result = await mammoth.extractRawText({ buffer: entryBuffer });
            entryText = result.value;
          } else if (['.txt', '.md', '.rtf'].includes(entryExt)) {
            entryText = entryBuffer.toString('utf8');
          }
        } catch (e) {
          entryText = `[Could not parse ${entryName}]`;
        }
        if (entryText) {
          parts.push(`--- File: ${entryName} ---\n${entryText}`);
        }
      }
      extractedText = parts.join('\n\n');
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    const fileId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tempFilename = `${fileId}_${safeName}`;
    fs.writeFileSync(path.join(TEMP_UPLOADS_DIR, tempFilename), buffer);

    res.json({ text: extractedText, fileId, originalName: originalname, fileSize: buffer.length, fileType: ext || mimetype });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CLIENT RECORDS ROUTES ────────────────────────────────────────────────────

app.get('/api/clients', authMiddleware, (req, res) => {
  try {
    const clients = db.prepare(`
      SELECT ph.id, ph.client_name, ph.created_at, ph.status, ph.notes, ph.clinical_review_complete,
        u.username AS bcba,
        COUNT(DISTINCT pr.id) AS revision_count,
        MAX(pr.created_at) AS last_modified
      FROM plan_history ph
      LEFT JOIN users u ON ph.user_id = u.id
      LEFT JOIN plan_revisions pr ON pr.plan_id = ph.id
      GROUP BY ph.id
      ORDER BY ph.created_at DESC
    `).all();
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id', authMiddleware, (req, res) => {
  try {
    const client = db.prepare(`SELECT ph.*, u.username AS bcba FROM plan_history ph LEFT JOIN users u ON ph.user_id=u.id WHERE ph.id=?`).get(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const revisions = db.prepare('SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY revision_number ASC').all(req.params.id);
    const documents = db.prepare(`SELECT cd.*, u.username AS uploader FROM client_documents cd LEFT JOIN users u ON cd.uploaded_by=u.id WHERE cd.plan_id=? ORDER BY cd.uploaded_at DESC`).all(req.params.id);
    const goals = db.prepare('SELECT * FROM plan_goals WHERE plan_id = ? ORDER BY goal_number ASC').all(req.params.id);
    res.json({ ...client, revisions, documents, goals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id/status', authMiddleware, (req, res) => {
  try {
    db.prepare('UPDATE plan_history SET status=? WHERE id=?').run(req.body.status, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id/notes', authMiddleware, (req, res) => {
  try {
    db.prepare('UPDATE plan_history SET notes=? WHERE id=?').run(req.body.notes, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', authMiddleware, (req, res) => {
  try {
    const planRecord = db.prepare('SELECT client_name FROM plan_history WHERE id=?').get(req.params.id);
    const uploadDir = path.join(UPLOADS_DIR, 'clients', req.params.id);
    if (fs.existsSync(uploadDir)) fs.rmSync(uploadDir, { recursive: true, force: true });
    db.prepare('DELETE FROM plan_goals WHERE plan_id=?').run(req.params.id);
    db.prepare('DELETE FROM client_documents WHERE plan_id=?').run(req.params.id);
    db.prepare('DELETE FROM plan_revisions WHERE plan_id=?').run(req.params.id);
    db.prepare('DELETE FROM plan_history WHERE id=?').run(req.params.id);
    logActivity(req.user.id, req.user.username, 'deleted_plan', 'plan', Number(req.params.id), planRecord?.client_name || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLIENT DOCUMENTS ─────────────────────────────────────────────────────────

app.post('/api/clients/:id/documents', authMiddleware, uploadClient.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, filename, mimetype, size } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    const periodId = req.body.authorization_period_id ? Number(req.body.authorization_period_id) : null;
    const result = db.prepare(
      'INSERT INTO client_documents (plan_id, filename, original_name, file_type, file_size, uploaded_by, authorization_period_id) VALUES (?,?,?,?,?,?,?)'
    ).run(req.params.id, filename, originalname, ext || mimetype, size, req.user.id, periodId);
    const doc = db.prepare('SELECT cd.*, u.username AS uploader FROM client_documents cd LEFT JOIN users u ON cd.uploaded_by=u.id WHERE cd.id=?').get(result.lastInsertRowid);
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id/documents', authMiddleware, (req, res) => {
  try {
    let docs;
    if (req.query.period_id) {
      docs = db.prepare(`SELECT cd.*, u.username AS uploader FROM client_documents cd LEFT JOIN users u ON cd.uploaded_by=u.id WHERE cd.plan_id=? AND cd.authorization_period_id=? ORDER BY cd.uploaded_at DESC`).all(req.params.id, req.query.period_id);
    } else {
      docs = db.prepare(`SELECT cd.*, u.username AS uploader FROM client_documents cd LEFT JOIN users u ON cd.uploaded_by=u.id WHERE cd.plan_id=? ORDER BY cd.uploaded_at DESC`).all(req.params.id);
    }
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id/documents/:doc_id/download', authMiddleware, (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM client_documents WHERE id=? AND plan_id=?').get(req.params.doc_id, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(UPLOADS_DIR, 'clients', req.params.id, doc.filename);
    res.download(filePath, doc.original_name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients/:id/documents/:doc_id/extract', authMiddleware, (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM client_documents WHERE id=? AND plan_id=?').get(req.params.doc_id, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(UPLOADS_DIR, 'clients', req.params.id, doc.filename);
    const ext = path.extname(doc.original_name).toLowerCase();
    if (ext === '.txt' || ext === '.md' || ext === '.json') {
      const text = fs.readFileSync(filePath, 'utf8');
      return res.json({ text });
    }
    return res.status(400).json({ error: `Document text extraction for ${ext || 'this file type'} is not yet supported. Please copy and paste the text manually.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id/documents/:doc_id', authMiddleware, (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM client_documents WHERE id=? AND plan_id=?').get(req.params.doc_id, req.params.id);
    if (doc) {
      const filePath = path.join(UPLOADS_DIR, 'clients', req.params.id, doc.filename);
      try { fs.unlinkSync(filePath); } catch(e) {}
      db.prepare('DELETE FROM client_documents WHERE id=?').run(req.params.doc_id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AUTHORIZATION PERIODS ────────────────────────────────────────────────────

app.get('/api/clients/:id/auth-periods', authMiddleware, (req, res) => {
  try {
    const periods = db.prepare('SELECT * FROM authorization_periods WHERE plan_id=? ORDER BY period_number ASC').all(req.params.id);
    res.json(periods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/:id/auth-periods', authMiddleware, (req, res) => {
  try {
    const { start_date, end_date, status = 'active' } = req.body;
    const existing = db.prepare('SELECT COUNT(*) AS cnt FROM authorization_periods WHERE plan_id=?').get(req.params.id);
    const period_number = existing.cnt + 1;
    const period_type = period_number === 1 ? 'initial' : 'reauth';
    const result = db.prepare(
      'INSERT INTO authorization_periods (plan_id, period_number, period_type, start_date, end_date, status) VALUES (?,?,?,?,?,?)'
    ).run(req.params.id, period_number, period_type, start_date || null, end_date || null, status);
    const period = db.prepare('SELECT * FROM authorization_periods WHERE id=?').get(result.lastInsertRowid);
    res.json(period);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/:id/auth-periods/:period_id', authMiddleware, (req, res) => {
  try {
    const { start_date, end_date, status } = req.body;
    db.prepare(
      'UPDATE authorization_periods SET start_date=COALESCE(?,start_date), end_date=COALESCE(?,end_date), status=COALESCE(?,status) WHERE id=? AND plan_id=?'
    ).run(start_date ?? null, end_date ?? null, status ?? null, req.params.period_id, req.params.id);
    const period = db.prepare('SELECT * FROM authorization_periods WHERE id=?').get(req.params.period_id);
    res.json(period);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── CHAT ROUTES ──────────────────────────────────────────────────────────────

app.get('/api/chat/:plan_id', authMiddleware, (req, res) => {
  try {
    const messages = db.prepare(
      'SELECT * FROM chat_messages WHERE plan_id = ? ORDER BY created_at ASC'
    ).all(req.params.plan_id);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat/:plan_id', authMiddleware, async (req, res) => {
  let keepAlive = null;
  let streamRef = null;

  const cleanup = () => {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamRef) { try { streamRef.abort(); } catch {} streamRef = null; }
  };

  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const plan = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(req.params.plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const latestRevision = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision_number DESC LIMIT 1'
    ).get(req.params.plan_id);
    if (!latestRevision) return res.status(404).json({ error: 'No plan revision found' });

    const isReauth = plan.plan_type === 'reauth';
    const priorMessages = db.prepare(
      'SELECT role, content FROM chat_messages WHERE plan_id = ? ORDER BY created_at ASC'
    ).all(req.params.plan_id);

    let activeSystemPrompt;
    let messages;

    if (isReauth) {
      activeSystemPrompt = REAUTH_SYSTEM_PROMPT;
      messages = [
        {
          role: 'user',
          content: `Here is the previous treatment plan for ${plan.client_name || 'this client'}:\n\n${latestRevision.text}\n\nReauth context (previous goals and new assessment documents):\n${plan.original_notes}`,
        },
        {
          role: 'assistant',
          content: `I've reviewed the previous treatment plan and new assessment documents for ${plan.client_name || 'this client'}. What would you like to start with?`,
        },
        ...priorMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];
    } else {
      const activePrompt = db.prepare('SELECT * FROM prompt_versions WHERE is_active = 1').get();
      const systemPrompt = activePrompt ? activePrompt.text : 'You are an ABA treatment plan assistant.';
      activeSystemPrompt = `${systemPrompt}\n\n---\nYou are in CONVERSATION MODE helping a BCBA refine a treatment plan. Respond conversationally and concisely. When the user asks for changes, describe what you would change and confirm. Do NOT output the entire treatment plan. Address only the specific request. The user can click "Regenerate Full Plan" when ready to apply all changes at once.`;
      messages = [
        {
          role: 'user',
          content: `Here is the current treatment plan for ${plan.client_name || 'this client'}:\n\n${latestRevision.text}\n\nOriginal client notes:\n${plan.original_notes}`,
        },
        {
          role: 'assistant',
          content: `I've reviewed the treatment plan for ${plan.client_name || 'this client'}. What changes would you like to make?`,
        },
        ...priorMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];
    }

    db.prepare('INSERT INTO chat_messages (plan_id, role, content, username) VALUES (?, ?, ?, ?)').run(
      req.params.plan_id, 'user', message, req.user.username
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write(': connected\n\n');

    let clientConnected = true;
    res.on('close', () => { clientConnected = false; cleanup(); });

    let replyText = '';
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: isReauth ? 8000 : 2000,
      system: [{ type: 'text', text: activeSystemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    streamRef = stream;

    keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

    stream.on('text', (chunk) => {
      replyText += chunk;
      try { res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`); } catch {}
    });

    stream.on('finalMessage', () => {
      cleanup();
      db.prepare('INSERT INTO chat_messages (plan_id, role, content, username) VALUES (?, ?, ?, ?)').run(
        req.params.plan_id, 'assistant', replyText, 'Claude'
      );
      if (clientConnected) {
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      }
    });

    stream.on('error', (err) => {
      cleanup();
      console.error('Chat stream error:', err);
      if (clientConnected) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      }
    });

  } catch (err) {
    cleanup();
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GOAL BANK ROUTES ─────────────────────────────────────────────────────────

app.get('/api/goal-bank', authMiddleware, (req, res) => {
  try {
    const domain = req.query.domain;
    let goals;
    if (domain) {
      goals = db.prepare('SELECT * FROM goal_bank WHERE domain = ? ORDER BY created_at DESC').all(domain);
    } else {
      goals = db.prepare('SELECT * FROM goal_bank ORDER BY domain, created_at DESC').all();
    }
    res.json(goals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/goal-bank', authMiddleware, bcbaMiddleware,
  body('domain').isIn(['Communication','Social','Adaptive','Behavior Reduction','Caregiver Training']).withMessage('Invalid domain'),
  body('goal_text').trim().notEmpty().withMessage('Goal text is required'),
  handleValidationErrors,
  (req, res) => {
    try {
      const { domain, goal_text, baseline_template, is_ferb } = req.body;
      const result = db.prepare(
        'INSERT INTO goal_bank (domain, goal_text, baseline_template, is_ferb, created_by) VALUES (?, ?, ?, ?, ?)'
      ).run(domain, goal_text, baseline_template || '', is_ferb ? 1 : 0, req.user.id);
      const goal = db.prepare('SELECT * FROM goal_bank WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(goal);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.put('/api/goal-bank/:id', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    const { domain, goal_text, baseline_template, is_ferb } = req.body;
    db.prepare(
      'UPDATE goal_bank SET domain = ?, goal_text = ?, baseline_template = ?, is_ferb = ? WHERE id = ?'
    ).run(domain, goal_text, baseline_template || '', is_ferb ? 1 : 0, req.params.id);
    const goal = db.prepare('SELECT * FROM goal_bank WHERE id = ?').get(req.params.id);
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/goal-bank/:id', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM goal_bank WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PLAN GOALS (ATTACH GOALS FROM BANK TO A PLAN) ────────────────────────────

app.post('/api/plans/:id/goals', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    const { goal_bank_id, domain, goal_statement, baseline, is_ferb } = req.body;
    const planId = req.params.id;

    // Get next goal number
    const maxNum = db.prepare('SELECT MAX(goal_number) AS n FROM plan_goals WHERE plan_id = ?').get(planId);
    const goalNumber = (maxNum?.n || 0) + 1;

    const result = db.prepare(
      'INSERT INTO plan_goals (plan_id, goal_bank_id, domain, goal_number, goal_statement, baseline, is_ferb) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(planId, goal_bank_id || null, domain, goalNumber, goal_statement, baseline || '', is_ferb ? 1 : 0);

    const goal = db.prepare('SELECT * FROM plan_goals WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/plans/:id/goals/:goal_id', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    const { goal_statement, baseline, is_ferb, goal_number } = req.body;
    db.prepare(
      'UPDATE plan_goals SET goal_statement = ?, baseline = ?, is_ferb = ?, goal_number = ? WHERE id = ? AND plan_id = ?'
    ).run(goal_statement, baseline || '', is_ferb ? 1 : 0, goal_number, req.params.goal_id, req.params.id);
    const goal = db.prepare('SELECT * FROM plan_goals WHERE id = ?').get(req.params.goal_id);
    res.json(goal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/plans/:id/goals/:goal_id', authMiddleware, bcbaMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM plan_goals WHERE id = ? AND plan_id = ?').run(req.params.goal_id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXPORT ROUTE (WITH CLINICAL GATE) ────────────────────────────────────────

app.get('/api/export/:plan_id/:revision_number', authMiddleware, async (req, res) => {
  try {
    const { plan_id, revision_number } = req.params;
    const plan = db.prepare('SELECT * FROM plan_history WHERE id = ?').get(plan_id);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const revision = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id = ? AND revision_number = ?'
    ).get(plan_id, revision_number);
    if (!revision) return res.status(404).json({ error: 'Revision not found' });

    // Clinical export gate
    const readiness = checkClinicalReadiness(plan_id, revision.text);
    if (!readiness.ready) {
      return res.status(403).json({ error: readiness.reason });
    }

    console.log(`[export] plan_id=${plan_id} rev=${revision_number} text_length=${revision.text.length} chars`);
    const logoBuffer = fs.existsSync(path.join(DATA_DIR, 'company-logo.png')) ? fs.readFileSync(path.join(DATA_DIR, 'company-logo.png')) : null;
    const doc = buildDocx(revision.text, plan.client_name, logoBuffer);
    let buffer = await Packer.toBuffer(doc);
    buffer = postProcessDocxBuffer(buffer);
    const safeName = (plan.client_name || 'treatment-plan').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-');
    const filename = `treatment-plan-${safeName}-rev${revision_number}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    logActivity(req.user.id, req.user.username, 'exported_plan', 'plan', Number(plan_id), `revision ${revision_number}`);
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── PROMPT ROUTES ────────────────────────────────────────────────────────────

app.get('/api/prompt', authMiddleware, (req, res) => {
  try {
    const prompt = db.prepare('SELECT * FROM prompt_versions WHERE is_active = 1').get();
    if (!prompt) return res.status(404).json({ error: 'No active prompt found' });
    res.json(prompt);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prompt', authMiddleware, adminMiddleware,
  body('text').trim().notEmpty().withMessage('text is required'),
  body('label').trim().notEmpty().withMessage('label is required'),
  handleValidationErrors,
  (req, res) => {
    try {
      const { text, label } = req.body;
      db.prepare('UPDATE prompt_versions SET is_active = 0').run();
      const result = db.prepare(
        'INSERT INTO prompt_versions (text, label, is_active) VALUES (?, ?, 1)'
      ).run(text, label);
      const newPrompt = db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(result.lastInsertRowid);
      logActivity(req.user.id, req.user.username, 'edited_prompt', 'prompt', newPrompt.id, label);
      res.json(newPrompt);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/prompt/history', authMiddleware, (req, res) => {
  try {
    const versions = db.prepare('SELECT * FROM prompt_versions ORDER BY created_at DESC').all();
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prompt/restore/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const prompt = db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id);
    if (!prompt) return res.status(404).json({ error: 'Prompt version not found' });

    db.prepare('UPDATE prompt_versions SET is_active = 0').run();
    db.prepare('UPDATE prompt_versions SET is_active = 1 WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.username, 'restored_prompt', 'prompt', Number(id), `version ${id}`);
    res.json({ message: 'Prompt restored', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── USER ROUTES ──────────────────────────────────────────────────────────────

app.get('/api/users', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', authMiddleware, adminMiddleware,
  body('username').trim().notEmpty().withMessage('Username is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('role').isIn(['Admin', 'BCBA', 'Student']).withMessage('Role must be Admin, BCBA, or Student'),
  handleValidationErrors,
  async (req, res) => {
    try {
      const { username, password, role } = req.body;
      const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (exists) return res.status(409).json({ error: 'Username already exists' });

      const hash = await bcrypt.hash(password, 10);
      const result = db.prepare(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
      ).run(username, hash, role);

      const newUser = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
      logActivity(req.user.id, req.user.username, 'created_user', 'user', newUser.id, username);
      res.status(201).json(newUser);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.delete('/api/users/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logActivity(req.user.id, req.user.username, 'deleted_user', 'user', Number(id), user.username);
    res.json({ message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LOGO ROUTES ──────────────────────────────────────────────────────────────

const LOGO_PATH = path.join(DATA_DIR, 'company-logo.png');

app.post('/api/settings/logo', authMiddleware, uploadLogo.single('logo'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    fs.writeFileSync(LOGO_PATH, req.file.buffer);
    logActivity(req.user.id, req.user.username, 'uploaded_logo', 'settings', null, null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings/logo', (req, res) => {
  if (!fs.existsSync(LOGO_PATH)) return res.status(404).json({ error: 'No logo uploaded' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(LOGO_PATH);
});

app.delete('/api/settings/logo', authMiddleware, adminMiddleware, (req, res) => {
  try {
    if (fs.existsSync(LOGO_PATH)) fs.unlinkSync(LOGO_PATH);
    logActivity(req.user.id, req.user.username, 'deleted_logo', 'settings', null, null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BACKUP ROUTES ────────────────────────────────────────────────────────────

app.get('/api/admin/backup', authMiddleware, adminMiddleware, (req, res) => {
  const result = runBackup();
  if (!result) return res.status(500).json({ error: 'Backup failed' });
  res.json({ ok: true, filename: result.filename, bytes: result.bytes });
});

app.get('/api/admin/backup/download', authMiddleware, adminMiddleware, (req, res) => {
  const filename = latestBackup();
  if (!filename) return res.status(404).json({ error: 'No backup found' });
  const filepath = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup file not found' });
  res.download(filepath, filename);
});

// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────

app.get('/api/activity-log', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const entries = db.prepare(`
      SELECT a.*, p.client_name
      FROM activity_log a
      LEFT JOIN plan_history p ON a.target_type = 'plan' AND a.target_id = p.id
      ORDER BY a.created_at DESC LIMIT 200
    `).all();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── INSURANCE TEMPLATES ──────────────────────────────────────────────────────

app.post('/api/insurance-templates/extract', authMiddleware, adminMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let text = '';

    if (ext === '.txt' || mimetype === 'text/plain') {
      text = buffer.toString('utf8');
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload a DOCX or TXT file.' });
    }

    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return res.status(400).json({ error: 'Could not extract text from the file.' });
    res.json({ text, filename: originalname, chars: text.length });
  } catch (err) {
    console.error('Insurance template extract error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/insurance-templates', authMiddleware, (req, res) => {
  try {
    const templates = db.prepare('SELECT id, name, created_at FROM insurance_templates ORDER BY name ASC').all();
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/insurance-templates/:id', authMiddleware, (req, res) => {
  try {
    const t = db.prepare('SELECT * FROM insurance_templates WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/insurance-templates', authMiddleware, adminMiddleware,
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('text').trim().notEmpty().withMessage('Rules text is required'),
  handleValidationErrors,
  (req, res) => {
    try {
      const { name, text } = req.body;
      const result = db.prepare('INSERT INTO insurance_templates (name, text, created_by) VALUES (?, ?, ?)').run(name.trim(), text.trim(), req.user.id);
      logActivity(req.user.id, req.user.username, 'created_insurance_template', 'insurance_template', result.lastInsertRowid, name.trim());
      res.json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.put('/api/insurance-templates/:id', authMiddleware, adminMiddleware,
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('text').trim().notEmpty().withMessage('Rules text is required'),
  handleValidationErrors,
  (req, res) => {
    try {
      const { name, text } = req.body;
      const existing = db.prepare('SELECT * FROM insurance_templates WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Template not found' });
      const versionCount = db.prepare('SELECT COUNT(*) as c FROM insurance_template_versions WHERE template_id = ?').get(req.params.id).c;
      db.prepare('INSERT INTO insurance_template_versions (template_id, name, text, version_number, saved_by) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, existing.name, existing.text, versionCount + 1, req.user.id);
      db.prepare('UPDATE insurance_templates SET name = ?, text = ? WHERE id = ?').run(name.trim(), text.trim(), req.params.id);
      logActivity(req.user.id, req.user.username, 'updated_insurance_template', 'insurance_template', Number(req.params.id), name.trim());
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

app.get('/api/insurance-templates/:id/versions', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const versions = db.prepare(
      'SELECT id, version_number, name, created_at FROM insurance_template_versions WHERE template_id = ? ORDER BY version_number DESC'
    ).all(req.params.id);
    res.json(versions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/insurance-templates/:id/versions/:vid/restore', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const version = db.prepare('SELECT * FROM insurance_template_versions WHERE id = ? AND template_id = ?').get(req.params.vid, req.params.id);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    const existing = db.prepare('SELECT * FROM insurance_templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    const versionCount = db.prepare('SELECT COUNT(*) as c FROM insurance_template_versions WHERE template_id = ?').get(req.params.id).c;
    db.prepare('INSERT INTO insurance_template_versions (template_id, name, text, version_number, saved_by) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, existing.name, existing.text, versionCount + 1, req.user.id);
    db.prepare('UPDATE insurance_templates SET name = ?, text = ? WHERE id = ?').run(version.name, version.text, req.params.id);
    logActivity(req.user.id, req.user.username, 'restored_insurance_template_version', 'insurance_template', Number(req.params.id), `v${version.version_number}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/insurance-templates/:id', authMiddleware, adminMiddleware, (req, res) => {
  try {
    const existing = db.prepare('SELECT id, name FROM insurance_templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    db.prepare('DELETE FROM insurance_templates WHERE id = ?').run(req.params.id);
    logActivity(req.user.id, req.user.username, 'deleted_insurance_template', 'insurance_template', Number(req.params.id), existing.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── COMPLIANCE CHECKS ────────────────────────────────────────────────────────

app.post('/api/compliance/extract', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let text = '';
    if (ext === '.docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } else if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      text = data.text;
    } else if (ext === '.txt') {
      text = buffer.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use DOCX or TXT.' });
    }
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    res.json({ text, filename: originalname, chars: text.length });
  } catch (err) {
    console.error('Compliance extract error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/compliance/checks', authMiddleware, (req, res) => {
  try {
    const checks = db.prepare(
      'SELECT id, document_name, template_name, result_text, created_at FROM compliance_checks WHERE checked_by = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.user.id);
    res.json(checks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compliance/check', authMiddleware, async (req, res) => {
  let keepAlive = null;
  let streamRef = null;

  const cleanup = () => {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamRef) { try { streamRef.abort(); } catch {} streamRef = null; }
  };

  try {
    const { template_id, plan_text, document_name } = req.body;
    if (!template_id) return res.status(400).json({ error: 'template_id is required' });
    if (!plan_text || !plan_text.trim()) return res.status(400).json({ error: 'plan_text is required' });

    const template = db.prepare('SELECT * FROM insurance_templates WHERE id = ?').get(template_id);
    if (!template) return res.status(404).json({ error: 'Insurance template not found' });

    const planText = plan_text.replace(/^\n{3,}/gm, '\n\n').trim();
    const docLabel = document_name || 'Uploaded Plan';

    const complianceSystemPrompt = `You are an expert compliance reviewer for ABA (Applied Behavior Analysis) treatment plans. Your job is to carefully review a treatment plan against insurance company rules and requirements.

For each requirement in the insurance rules, determine if the treatment plan:
- PASSES: The plan clearly and fully meets this requirement
- NEEDS REVISION: The plan is missing or incomplete for this requirement — provide a specific recommendation for what to add or change
- WARNING: The plan partially meets this requirement, or it is ambiguous and may need clarification

IMPORTANT: These are clinical recommendations to help the BCBA strengthen the plan before submission — NOT determinations of denial or approval. Frame all feedback as guidance for improvement, not as authorization decisions. Never use the words "denial," "denied," or "deny." Instead use language like "recommend adding," "suggest clarifying," "this section needs," or "consider including."

Be thorough and specific. Cite exact sections or quotes from the plan when relevant. For each item needing revision or clarification, provide a clear, actionable recommendation.`;

    const userMessage = `Please review the following ABA treatment plan for compliance with the insurance rules provided.

=== INSURANCE RULES: ${template.name} ===
${template.text}

=== TREATMENT PLAN ===
${planText}

=== INSTRUCTIONS ===
Review the plan against every rule and requirement in the insurance rules document above.

Format your response exactly as follows:

## Compliance Check: ${template.name}
**Document:** ${docLabel}

### Summary
[2-3 sentence overall compliance assessment]

### ❌ Needs Revision
[List each requirement needing revision. If none, write "None identified."]
For each: **Rule:** [requirement] → **Issue:** [what's missing or incomplete] → **Recommendation:** [specific suggestion for what to add or change]

### ⚠️ Needs Clarification
[List each item that is partially met or ambiguous. If none, write "None identified."]
For each: **Rule:** [requirement] → **Issue:** [what's unclear or partially met] → **Recommendation:** [what to clarify or strengthen]

### ✅ Meets Requirements
[List each requirement that is clearly met, with brief confirmation]`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write(': connected\n\n');

    let clientConnected = true;
    res.on('close', () => { clientConnected = false; cleanup(); });

    const send = (obj) => {
      if (!clientConnected) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    let resultText = '';
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      system: complianceSystemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    streamRef = stream;

    keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

    stream.on('text', (chunk) => {
      resultText += chunk;
      send({ type: 'chunk', text: chunk.replace(/<br\s*\/?>/gi, '\n') });
    });

    stream.on('finalMessage', (msg) => {
      cleanup();
      const checkResult = db.prepare(
        'INSERT INTO compliance_checks (plan_id, document_name, template_id, template_name, result_text, checked_by) VALUES (NULL, ?, ?, ?, ?, ?)'
      ).run(docLabel, template_id, template.name, resultText, req.user.id);
      console.log(`[compliance] done. stop_reason=${msg.stop_reason} output=${resultText.length} chars. saved check_id=${checkResult.lastInsertRowid}`);
      logActivity(req.user.id, req.user.username, 'compliance_check', 'document', null, `${docLabel} vs ${template.name}`);
      if (clientConnected) {
        send({ type: 'done', check_id: checkResult.lastInsertRowid });
        res.end();
      }
    });

    stream.on('error', (err) => {
      cleanup();
      console.error('Compliance stream error:', err);
      if (clientConnected) {
        send({ type: 'error', error: err.message });
        res.end();
      }
    });

  } catch (err) {
    cleanup();
    console.error('Compliance check error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compliance/chat', authMiddleware, async (req, res) => {
  let keepAlive = null;
  let streamRef = null;

  const cleanup = () => {
    if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
    if (streamRef) { try { streamRef.abort(); } catch {} streamRef = null; }
  };

  try {
    const { check_result, messages, document_name } = req.body;
    if (!check_result) return res.status(400).json({ error: 'check_result is required' });
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages is required' });

    const docLabel = document_name || 'this plan';
    const systemPrompt = `You are a compliance expert helping a BCBA strengthen an ABA treatment plan before submission. You have the full compliance review result as context. Help the user understand what needs revision, draft corrective language for incomplete sections, write summary reports, or answer any questions about the requirements. Be concise and practical. Frame all feedback as recommendations for improvement — never as denials or authorization decisions. Never use the words "denial," "denied," or "deny."`;

    const apiMessages = [
      { role: 'user', content: `The compliance check result for ${docLabel}:\n\n${check_result}` },
      { role: 'assistant', content: `I've reviewed the compliance results for ${docLabel}. I can help you understand failures, draft corrective text, or generate a summary report. What would you like to work on?` },
      ...messages,
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);
    res.write(': connected\n\n');

    let clientConnected = true;
    res.on('close', () => { clientConnected = false; cleanup(); });

    const send = (obj) => {
      if (!clientConnected) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
    };

    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: apiMessages,
    });
    streamRef = stream;

    keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000);

    stream.on('text', (chunk) => send({ type: 'chunk', text: chunk.replace(/<br\s*\/?>/gi, '\n') }));

    stream.on('finalMessage', () => {
      cleanup();
      if (clientConnected) { send({ type: 'done' }); res.end(); }
    });

    stream.on('error', (err) => {
      cleanup();
      if (clientConnected) { send({ type: 'error', error: err.message }); res.end(); }
    });

  } catch (err) {
    cleanup();
    console.error('Compliance chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── REAUTH ROUTE ─────────────────────────────────────────────────────────────

app.post('/api/clients/:id/auth-periods/:period_id/start-reauth', authMiddleware, bcbaMiddleware, async (req, res) => {
  try {
    const planId = req.params.id;
    const periodId = req.params.period_id;

    const period = db.prepare('SELECT * FROM authorization_periods WHERE id=? AND plan_id=?').get(periodId, planId);
    if (!period) return res.status(404).json({ error: 'Period not found' });
    if (period.period_type !== 'reauth') return res.status(400).json({ error: 'This period is not a reauth period' });
    if (period.status !== 'active') return res.status(400).json({ error: 'Period is not active' });

    const plan = db.prepare('SELECT * FROM plan_history WHERE id=?').get(planId);
    if (!plan) return res.status(404).json({ error: 'Client plan not found' });

    const latestRevision = db.prepare(
      'SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY revision_number DESC LIMIT 1'
    ).get(planId);
    const previousPlanText = latestRevision ? latestRevision.text : '';

    const goalLines = previousPlanText.split('\n')
      .filter(line => /^\s*\d+\.\s+\**(?:\(FERB\)\s+)?\**Goal Statement:/i.test(line));
    const goalCount = goalLines.length;
    const goalSummary = goalLines.length > 0 ? goalLines.join('\n') : 'No goals found in previous plan.';

    const periodDocs = db.prepare(
      'SELECT * FROM client_documents WHERE plan_id=? AND authorization_period_id=?'
    ).all(planId, periodId);

    const docTexts = [];
    for (const doc of periodDocs) {
      try {
        const filePath = path.join(UPLOADS_DIR, 'clients', planId, doc.filename);
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(doc.original_name).toLowerCase();
        let text = '';
        if (ext === '.docx') {
          const r = await mammoth.extractRawText({ buffer });
          text = r.value;
        } else if (['.txt','.md','.rtf'].includes(ext)) {
          text = buffer.toString('utf8');
        } else {
          text = '[Unsupported file type for text extraction]';
        }
        docTexts.push(`--- ${doc.original_name} ---\n${text.trim()}`);
      } catch (e) {
        docTexts.push(`--- ${doc.original_name} --- [Error extracting: ${e.message}]`);
      }
    }

    const reauthContext = [
      `=== PREVIOUS TREATMENT PLAN GOALS (${goalCount} goal${goalCount !== 1 ? 's' : ''}) ===`,
      goalSummary,
      '',
      `=== NEW ASSESSMENT DOCUMENTS (${docTexts.length} file${docTexts.length !== 1 ? 's' : ''}) ===`,
      docTexts.length > 0 ? docTexts.join('\n\n') : 'No documents uploaded for this reauth period.',
    ].join('\n');

    const insertResult = db.prepare(
      'INSERT INTO plan_history (user_id, client_name, original_notes, plan_type) VALUES (?, ?, ?, ?)'
    ).run(req.user.id, plan.client_name, reauthContext, 'reauth');
    const reauthPlanId = insertResult.lastInsertRowid;

    db.prepare(
      'INSERT INTO plan_revisions (plan_id, revision_number, text, feedback) VALUES (?, ?, ?, ?)'
    ).run(
      reauthPlanId,
      0,
      previousPlanText || '# Reauth Plan\n\nUse the chat to generate the reauthorization treatment plan.',
      'Previous plan reference'
    );

    const greeting = `I've reviewed the previous treatment plan for **${plan.client_name}** and the reauth documents.\n\n` +
      `**Summary:**\n` +
      `- ${goalCount} goal${goalCount !== 1 ? 's' : ''} from the previous authorization period\n` +
      `- ${docTexts.length} new assessment document${docTexts.length !== 1 ? 's' : ''} (${periodDocs.map(d => d.original_name).join(', ') || 'none'})\n\n` +
      `I can help you:\n` +
      `1. Analyze each previous goal (Mastered / Partially Met / Not Met) based on the new data\n` +
      `2. Write a Response to Treatment and Authorization Summary\n` +
      `3. Recommend which goals to continue, modify, or discontinue\n` +
      `4. Propose new goals based on the updated assessment scores\n` +
      `5. Generate the complete reauth treatment plan when ready\n\n` +
      `What would you like to start with?`;

    db.prepare('INSERT INTO chat_messages (plan_id, role, content, username) VALUES (?, ?, ?, ?)')
      .run(reauthPlanId, 'assistant', greeting, 'Claude');

    logActivity(req.user.id, req.user.username, 'started_reauth', 'plan', Number(reauthPlanId), plan.client_name);
    console.log(`[reauth] Created reauth plan_id=${reauthPlanId} for client "${plan.client_name}"`);

    res.json({ plan_id: reauthPlanId, client_name: plan.client_name });
  } catch (err) {
    console.error('Start reauth error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large' });
    }
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── 404 HANDLER FOR API ──────────────────────────────────────────────────────

app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// ─── SERVE REACT APP ──────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'dist', 'index.html'));
});

// ─── SERVER START ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`All Star ABA server running on http://localhost:${PORT}`);
  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000);
});
