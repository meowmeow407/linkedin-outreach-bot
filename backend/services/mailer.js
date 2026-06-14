const nodemailer = require('nodemailer');
const fs = require('fs');

/**
 * Sends a job application email to a recruiter with dynamic PDF resume attachment
 * and CC fields to Quinn and Kim.
 */
async function sendMail({ to, subject, htmlBody, attachmentPath, attachmentFilename }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_PASS;
  const ccEmails = process.env.CC_EMAILS || 'quinn@jpitstaffing.com,kim@jpitstaffing.com';

  if (!user || !pass) {
    throw new Error('GMAIL_USER or GMAIL_PASS are not configured in your backend/.env file.');
  }

  // Set up Nodemailer Gmail SMTP transporter
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: user,
      pass: pass
    }
  });

  const attachments = [];
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    attachments.push({
      filename: attachmentFilename || 'resume.pdf',
      path: attachmentPath
    });
  }

  const mailOptions = {
    from: `"Job Application Bot" <${user}>`,
    to: to,
    cc: ccEmails.split(',').map(email => email.trim()),
    subject: subject,
    html: htmlBody,
    attachments: attachments
  };

  console.log(`[Mailer] Sending email to: ${to} (CC: ${ccEmails})`);
  const info = await transporter.sendMail(mailOptions);
  console.log(`[Mailer] Email sent successfully. MessageID: ${info.messageId}`);
  return info;
}

module.exports = {
  sendMail
};
