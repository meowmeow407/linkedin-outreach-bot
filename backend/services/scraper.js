const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const COOKIES_PATH = path.join(DATA_DIR, 'cookies.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Perform manual or automated login to LinkedIn and save cookies
 */
async function loginLinkedIn(page, username, password) {
  console.log('[Scraper] Navigating to LinkedIn Login...');
  try {
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    console.warn('[Scraper] Login page navigation timed out or failed, checking if inputs are visible:', e.message);
  }

  // Fill credentials if forms are visible
  try {
    if (await page.locator('#username').isVisible({ timeout: 5000 })) {
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('button[type="submit"]');
    }
  } catch (e) {
    console.warn('[Scraper] Username/password fields not visible or interactable:', e.message);
  }

  // Wait for the user to solve CAPTCHA/2FA and get redirected to feed or search
  console.log('[Scraper] Waiting for dashboard navigation. Solve any CAPTCHAs manually in the browser window!');
  try {
    await page.waitForFunction(() => {
      return window.location.href.includes('/feed') || window.location.href.includes('/search');
    }, {}, { timeout: 180000 });
  } catch (e) {
    console.error('[Scraper] Login validation timed out. User might not have completed login/verification.');
    throw e;
  }

  // Save session cookies
  const cookies = await page.context().cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf8');
  console.log('[Scraper] LinkedIn session saved successfully.');
}

/**
 * Searches LinkedIn posts from the past 24 hours and extracts recruiter email addresses
 */
async function scrapeLinkedInPosts({ keywords, limit = 15 }) {
  const username = process.env.LINKEDIN_USERNAME;
  const password = process.env.LINKEDIN_PASSWORD;

  console.log(`[Scraper] Starting scrape for keywords: "${keywords}"`);
  
  // Launch Playwright (headless in production/cloud, headed in development)
  const isCloud = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production' || process.env.HEADLESS === 'true';
  console.log(`[Scraper] Launching browser (headless: ${isCloud})...`);
  const browser = await chromium.launch({
    headless: isCloud,
    args: isCloud ? ['--no-sandbox', '--disable-setuid-sandbox'] : []
  });

  const context = await browser.newContext();

  // Load session cookies if they exist in environment variable or file
  let cookies = null;
  if (process.env.LINKEDIN_COOKIES) {
    console.log('[Scraper] Restoring session cookies from environment variable...');
    try {
      cookies = JSON.parse(process.env.LINKEDIN_COOKIES);
    } catch (e) {
      console.warn('[Scraper] Failed to parse LINKEDIN_COOKIES env variable:', e.message);
    }
  }

  if (!cookies && fs.existsSync(COOKIES_PATH)) {
    console.log('[Scraper] Restoring saved session cookies from file...');
    try {
      cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    } catch (e) {
      console.warn('[Scraper] Failed to load saved cookies from file:', e.message);
    }
  }

  if (cookies) {
    try {
      await context.addCookies(cookies);
    } catch (e) {
      console.warn('[Scraper] Failed to add cookies to browser context:', e.message);
    }
  }

  const page = await context.newPage();

  try {
    // Navigate to feed to verify login status
    console.log('[Scraper] Checking authentication by loading feed...');
    try {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) {
      console.warn('[Scraper] Initial feed navigation timed out or failed, checking current URL:', e.message);
    }
    
    const currentUrl = page.url();
    const isLoggedIn = currentUrl.includes('/feed') || currentUrl.includes('/search');

    if (!isLoggedIn) {
      console.log(`[Scraper] Not logged in (current URL: ${currentUrl}). Initiating login...`);
      if (!username || !password) {
        throw new Error('LinkedIn login credentials missing in backend/.env file.');
      }
      await loginLinkedIn(page, username, password);
    } else {
      console.log('[Scraper] Logged in successfully using saved cookies.');
    }

    // Navigate directly to posts search page filtered to past 24 hours
    const encodedKeywords = encodeURIComponent(keywords);
    const searchUrl = `https://www.linkedin.com/search/results/content/?datePosted=%22past-24h%22&keywords=${encodedKeywords}`;
    
    console.log(`[Scraper] Navigating to search URL: ${searchUrl}`);
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.warn('[Scraper] Navigation to search URL timed out or failed:', e.message);
    }

    // Verify if we got redirected to login/checkpoint/signup (not logged in)
    if (page.url().includes('/login') || page.url().includes('/signup') || page.url().includes('/checkpoint') || !page.url().includes('/search')) {
      console.log('[Scraper] Redirected to login/checkpoint. Manual authentication required!');
      console.log('[Scraper] Please log in and solve any CAPTCHAs/2FAs in the browser window.');
      
      // Wait for the user to be on the feed or search page (up to 5 minutes)
      await page.waitForFunction(() => {
        return window.location.href.includes('/feed') || window.location.href.includes('/search');
      }, {}, { timeout: 300000 });

      // Save new session cookies
      const cookies = await page.context().cookies();
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf8');
      console.log('[Scraper] Login successful. Session cookies updated.');

      // Redirect back to search results if not already there
      if (!page.url().includes('/search')) {
        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
          console.warn('[Scraper] Post-login navigation to search URL timed out or failed:', e.message);
        }
      }
    }

    // Wait for at least one search result post card to load
    console.log('[Scraper] Waiting for search result cards to load...');
    try {
      await page.waitForSelector('[role="listitem"], .feed-shared-update-v2, .reusable-search__result-container', { timeout: 20000 });
      console.log('[Scraper] Search results elements found on the page.');
    } catch (e) {
      console.warn('[Scraper] Timeout waiting for search result cards. Proceeding to scroll:', e.message);
    }

    // Scroll down multiple times to load lazy-loaded search result posts
    console.log('[Scraper] Scrolling to fetch post content...');
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(2000);
    }

    // Evaluate the document body to find the post updates
    const posts = await page.evaluate(() => {
      const cards = document.querySelectorAll('[role="listitem"], .feed-shared-update-v2, .search-relevance-card, .reusable-search__result-container');
      const results = [];

      cards.forEach((card, index) => {
        // Look for description/text elements
        const textEl = card.querySelector('[data-testid="expandable-text-box"], .feed-shared-update-v2__description, .feed-shared-text, .update-components-text');
        const text = textEl ? textEl.innerText : card.innerText;

        // Look for Author info (robust multi-strategy detection)
        let author = 'LinkedIn User';

        // Strategy 1: Look at img alt text "View X's profile"
        const avatarImg = card.querySelector('img[alt^="View "]');
        if (avatarImg) {
          const alt = avatarImg.getAttribute('alt');
          const match = alt.match(/^View\s+(.+?)(?:’s|'s)\s+profile/i);
          if (match) {
            author = match[1].trim();
          }
        }

        // Strategy 2: If still default, look at aria-label on elements inside the card
        if (author === 'LinkedIn User') {
          const followBtn = card.querySelector('[aria-label^="Follow "]');
          if (followBtn) {
            const label = followBtn.getAttribute('aria-label');
            author = label.substring(7).trim();
          }
        }

        if (author === 'LinkedIn User') {
          const menuBtn = card.querySelector('[aria-label*="post by "]');
          if (menuBtn) {
            const label = menuBtn.getAttribute('aria-label');
            const match = label.match(/post by\s+(.+)$/i);
            if (match) {
              author = match[1].trim();
            }
          }
        }

        if (author === 'LinkedIn User') {
          // Strategy 3: Find links with "/in/"
          const profileLink = card.querySelector('a[href*="/in/"]');
          if (profileLink && profileLink.innerText.trim()) {
            author = profileLink.innerText.trim().split('\n')[0];
          }
        }

        if (author === 'LinkedIn User') {
          // Strategy 4: Fallback to old obfuscated selector check
          const authorEl = card.querySelector('.feed-shared-actor__title, .feed-shared-actor__name');
          if (authorEl && authorEl.innerText.trim()) {
            author = authorEl.innerText.trim();
          }
        }

        // Look for Link to post
        const postLinkEl = card.querySelector('a[href*="/feed/update"]');
        let link = window.location.href;
        if (postLinkEl) {
          link = postLinkEl.href;
        } else {
          const profileLinkEl = card.querySelector('a[href*="/in/"]');
          if (profileLinkEl) {
            link = profileLinkEl.href;
          }
        }

        results.push({
          id: `post_${Date.now()}_${index}`,
          author,
          text,
          link,
          scrapedAt: new Date().toISOString()
        });
      });

      return results;
    });

    console.log(`[Scraper] Analyzed ${posts.length} raw LinkedIn posts.`);

    // Extract emails from the text of each post using standard regex pattern
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
    const leads = [];

    for (const post of posts) {
      const emails = post.text.match(emailRegex);
      if (emails && emails.length > 0) {
        // Deduplicate and filter out media/asset files ending in image extensions
        const uniqueEmails = [...new Set(emails.map(e => e.toLowerCase()))];
        const validEmails = uniqueEmails.filter(e => {
          const invalidSuffixes = ['.png', '.jpg', '.jpeg', '.gif', '.pdf', 'example.com'];
          return !invalidSuffixes.some(suffix => e.endsWith(suffix));
        });

        if (validEmails.length > 0) {
          leads.push({
            id: post.id,
            company_name: 'extracted_from_linkedin',
            contact_name: post.author,
            email: validEmails[0],
            source: 'LinkedIn Search',
            notes: post.text.slice(0, 100) + '...',
            rawPostText: post.text,
            postLink: post.link,
            scrapedAt: post.scrapedAt
          });
        }
      }
    }

    console.log(`[Scraper] Successfully extracted ${leads.length} leads with recruiter emails.`);
    return leads;

  } catch (err) {
    console.error('[Scraper] Scraper crash:', err);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrapeLinkedInPosts
};
