const fs = require('fs');
const path = require('path');

const RESUMES_DIR = path.join(__dirname, '..', '..', 'data', 'resumes');
if (!fs.existsSync(RESUMES_DIR)) {
  fs.mkdirSync(RESUMES_DIR, { recursive: true });
}

/**
 * Tailors a candidate's resume to match a job description.
 * If GEMINI_API_KEY is configured, it uses Gemini to rewrite the key bullet points.
 * Otherwise, it uses a placeholder string-matching strategy.
 */
async function tailorResume({ candidateType, jobDescription, candidateName = 'Shyam' }) {
  console.log(`[ResumeBuilder] Tailoring resume for candidate: ${candidateName} (${candidateType})`);

  // Load the baseline resume template for the candidate type (txt or html)
  const templateFilename = `${candidateType.toLowerCase().replace(/[^a-z0-9]/g, '_')}_resume.txt`;
  const templatePath = path.join(RESUMES_DIR, templateFilename);

  // If the template file doesn't exist, create a default dummy template
  if (!fs.existsSync(templatePath)) {
    console.log(`[ResumeBuilder] Template not found at ${templatePath}. Creating a default dummy template.`);
    const defaultTemplate = `
CANDIDATE NAME: ${candidateName}
ROLE TYPE: ${candidateType}
SUMMARY:
Experienced ${candidateType} with a demonstrated history of delivering high-quality solutions. Specialized in C2C contracts.

CORE EXPERTISE:
- Java/J2EE, Spring Boot, Microservices (for Java Developers)
- Requirements gathering, Agile/Scrum, User Stories (for Business Analysts)
- Project Lifecycle, Budgeting, Risk Management (for Project Managers)
- SQL, Python, Tableau, Data Cleaning (for Data Analysts)

PROFESSIONAL EXPERIENCE:
- Senior Consultant | 2022 - Present
  * Spearheaded software development and deployment processes.
  * Optimized workflows leading to a 20% increase in efficiency.
- Software Engineer | 2019 - 2022
  * Developed robust application features based on user feedback.
  * Collaborated with cross-functional teams to deliver projects on time.
    `;
    fs.writeFileSync(templatePath, defaultTemplate.trim(), 'utf8');
  }

  const baseResume = fs.readFileSync(templatePath, 'utf8');
  const apiKey = process.env.GEMINI_API_KEY;

  let tailoredContent = baseResume;

  if (apiKey) {
    console.log('[ResumeBuilder] GEMINI_API_KEY found. Contacting Gemini to tailor resume...');
    try {
      // Lazy-load google-gen-ai or run an HTTP fetch to avoid heavy library requirements
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
      const prompt = `
You are an expert technical resume writer. You are given a baseline candidate resume and a Job Description. 
Modify the resume's SUMMARY and PROFESSIONAL EXPERIENCE bullet points so they match the Job Description requirements more closely. 
Keep all candidate information (Name, dates, company names) exactly the same, but rewrite the bullet points to align with the skills/experience requested in the Job Description.

Candidate Name: ${candidateName}
Baseline Resume:
"""
${baseResume}
"""

Job Description:
"""
${jobDescription}
"""

Output ONLY the tailored resume text. Do not include markdown code block syntax (like \`\`\`text) or conversational intro/outro text. Just output the raw tailored resume text.
      `;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (aiText) {
          tailoredContent = aiText.trim();
          console.log('[ResumeBuilder] Successfully tailored resume using Gemini.');
        }
      } else {
        console.warn(`[ResumeBuilder] Gemini API returned status ${response.status}. Falling back to default baseline.`);
      }
    } catch (err) {
      console.error('[ResumeBuilder] Failed to connect to Gemini API. Falling back to default baseline:', err.message);
    }
  } else {
    console.log('[ResumeBuilder] No GEMINI_API_KEY in .env. Using template baseline without AI modifications.');
    // Simple placeholder formatting
    tailoredContent = baseResume.replace('[JobTitle]', candidateType).replace('[CandidateName]', candidateName);
  }

  // Save the tailored resume to the data directory for attachment
  const outputFilename = `tailored_${candidateName.toLowerCase()}_${Date.now()}.txt`;
  const outputPath = path.join(RESUMES_DIR, outputFilename);
  fs.writeFileSync(outputPath, tailoredContent, 'utf8');

  return {
    path: outputPath,
    filename: `${candidateName}_Resume_${candidateType.replace(/\s+/g, '_')}.txt`,
    content: tailoredContent
  };
}

module.exports = {
  tailorResume
};
