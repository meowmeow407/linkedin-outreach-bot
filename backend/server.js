require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const scraperService = require('./services/scraper');
const mailerService = require('./services/mailer');
const resumeBuilder = require('./services/resumeBuilder');

const app = express();
const PORT = process.env.PORT || 5002;

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Helper function to read/write JSON files safely
function readJsonFile(filePath, defaultVal = []) {
  try {
    if (!fs.existsSync(filePath)) return defaultVal;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultVal;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Server] Failed to write file: ${filePath}`, err);
  }
}

function logAction(action, details) {
  const logs = readJsonFile(LOGS_FILE);
  logs.unshift({
    timestamp: new Date().toISOString(),
    action,
    details
  });
  writeJsonFile(LOGS_FILE, logs.slice(0, 1000));
}

// --- Routes ---

// Get active configuration status
app.get('/api/config', (req, res) => {
  res.json({
    gmailConfigured: !!(process.env.GMAIL_USER && process.env.GMAIL_PASS),
    linkedinConfigured: !!(process.env.LINKEDIN_USERNAME && process.env.LINKEDIN_PASSWORD),
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    ccEmails: process.env.CC_EMAILS || 'quinn@jpitstaffing.com,kim@jpitstaffing.com'
  });
});

// Fetch all scraped leads
app.get('/api/leads', (req, res) => {
  res.json(readJsonFile(LEADS_FILE));
});

// Clear all leads
app.post('/api/leads/clear', (req, res) => {
  writeJsonFile(LEADS_FILE, []);
  logAction('clear_leads', 'All scraped leads cleared.');
  res.json({ message: 'Leads cleared successfully.' });
});

// Get logs of all bot activity
app.get('/api/logs', (req, res) => {
  res.json(readJsonFile(LOGS_FILE));
});

// Trigger LinkedIn Scraping
app.post('/api/scrape', async (req, res) => {
  const { keywords } = req.body;
  if (!keywords) {
    return res.status(400).json({ error: 'Keywords are required (e.g. "Java Developer Contract")' });
  }

  try {
    logAction('scrape_start', `Starting scraping for keywords: "${keywords}"`);
    const newLeads = await scraperService.scrapeLinkedInPosts({ keywords });
    
    const existingLeads = readJsonFile(LEADS_FILE);
    const emailsSet = new Set(existingLeads.map(l => l.email.toLowerCase()));
    
    let addedCount = 0;
    for (const lead of newLeads) {
      if (!emailsSet.has(lead.email.toLowerCase())) {
        existingLeads.unshift({
          ...lead,
          status: 'new',
          appliedAt: null,
          applicationError: null
        });
        emailsSet.add(lead.email.toLowerCase());
        addedCount++;
      }
    }

    writeJsonFile(LEADS_FILE, existingLeads);
    logAction('scrape_success', `Scraping complete. Found ${newLeads.length} leads. Added ${addedCount} new unique leads.`);
    
    res.json({
      message: `Scraping complete. Found ${newLeads.length} leads, added ${addedCount} new unique leads to dashboard.`,
      total: existingLeads.length,
      added: addedCount
    });
  } catch (err) {
    logAction('scrape_failed', `Scraping failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Trigger Tailored Application & Email Send to a Recruiter
app.post('/api/apply', async (req, res) => {
  const { leadId, candidateType, candidateName = 'Shyam' } = req.body;

  if (!leadId || !candidateType) {
    return res.status(400).json({ error: 'leadId and candidateType are required' });
  }

  const leads = readJsonFile(LEADS_FILE);
  const leadIdx = leads.findIndex(l => l.id === leadId);
  if (leadIdx === -1) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  const lead = leads[leadIdx];

  try {
    logAction('apply_start', `Starting job application process for: ${lead.email} (${candidateType})`);

    // 1. Build the tailored resume using Gemini API / prompt substitution
    const resumeInfo = await resumeBuilder.tailorResume({
      candidateType,
      jobDescription: lead.rawPostText,
      candidateName
    });

    // 2. Draft the personalized cold email cover letter
    const greeting = lead.contact_name && lead.contact_name !== 'LinkedIn User' ? lead.contact_name : 'Team';
    const emailSubject = `Application for ${candidateType} Position - ${candidateName}`;
    const emailBody = `
      <p>Hello ${greeting},</p>
      <p>I hope you are having a productive day.</p>
      <p>I noticed your recent job posting on LinkedIn regarding the <strong>${candidateType}</strong> contract opportunity. I believe my background matches the requirements you are looking for.</p>
      <p>I have attached my tailored resume (containing submission details) to this email for your convenience.</p>
      <p>Looking forward to discussing how I can add value to your client's team.</p>
      <br>
      <p>Best regards,</p>
      <p><strong>${candidateName}</strong><br>
      Contract Professional | C2C Submission</p>
    `;

    // 3. Send email via SMTP (Gmail) with Quinn & Kim in CC
    const mailInfo = await mailerService.sendMail({
      to: lead.email,
      subject: emailSubject,
      htmlBody: emailBody,
      attachmentPath: resumeInfo.path,
      attachmentFilename: resumeInfo.filename
    });

    // 4. Update lead status in data file
    leads[leadIdx].status = 'applied';
    leads[leadIdx].appliedAt = new Date().toISOString();
    leads[leadIdx].applicationError = null;
    writeJsonFile(LEADS_FILE, leads);

    logAction('apply_success', `Successfully applied to recruiter ${lead.email} for ${candidateType}`);
    res.json({
      success: true,
      message: `Successfully sent tailored resume to recruiter at ${lead.email}`,
      messageId: mailInfo.messageId
    });

  } catch (err) {
    leads[leadIdx].status = 'failed';
    leads[leadIdx].applicationError = err.message;
    writeJsonFile(LEADS_FILE, leads);

    logAction('apply_failed', `Failed to apply to ${lead.email}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Start listening
app.listen(PORT, () => {
  console.log(`[Server] LinkedIn Outreach Bot listening on port ${PORT}`);
  console.log(`[Server] Data directory located at: ${DATA_DIR}`);
});
