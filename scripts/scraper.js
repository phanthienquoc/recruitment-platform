const { MongoClient } = require('mongodb');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error("Telegram Error:", e.message);
  }
}

async function run() {
  const uri = process.env.URI_MONGO;
  if (!uri) throw new Error("Missing URI_MONGO");

  console.log('[1/7] Starting scraper');

  const client = new MongoClient(uri);

  console.log('[2/7] Launching browser');
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();

  page.on('console', msg => {
    console.log('[browser]', msg.text());
  });

  try {
    await sendTelegram("🚀 <b>Scraper Started:</b>Recland...");

    console.log('[3/7] Connecting MongoDB');
    await client.connect();
    const db = client.db('job_automation');
    const jobsCollection = db.collection('jobs');

    console.log('[4/7] Loading page');
    await page.goto('https://recland.co/jobs-table-list', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('[5/7] Waiting table render');
    await page.waitForSelector('#jobsTable tbody tr');

    console.log('[6/7] Extracting jobs');

    const jobs = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#jobsTable tbody tr'));

      const getText = (el) => el?.innerText?.trim() || null;

      return rows.map((row, index) => {
        const cols = row.querySelectorAll('td');
        if (cols.length < 8) return null;

        // 👉 column chính chứa title + company
        const jobCol = cols[2];

        const linkEl = jobCol.querySelector('a.job-title-link');

        const title = getText(linkEl);
        const url = linkEl?.href;

        const jobId = url
          ? url.split('/').filter(Boolean).pop()
          : null;

        const company = getText(jobCol.querySelector('.company-name'));

        const category = getText(cols[3]);
        const location = getText(cols[4]);

        // type: urgent / normal
        const type = getText(cols[5]);

        const bonusType = getText(cols[6]);

        // salary phải lấy riêng
        const salary = getText(cols[7].querySelector('.salary-text'));

        const jobData = {
          jobId,
          title,
          company,
          category,
          location,
          type,
          bonusType,
          salary,
          url,
          status: 'pending',
          createdAt: new Date()
        };

        console.log(`row ${index + 1}`, jobData);

        return jobData;
      }).filter(j => j && j.jobId && j.url);
    });

    console.log(`[6/7] Extracted ${jobs.length} jobs`);

    let newJobsCount = 0;

    if (jobs.length > 0) {
      console.log('[6/7] Saving to MongoDB');

      const ops = jobs.map(job => ({
        updateOne: {
          filter: { jobId: job.jobId },
          update: { $setOnInsert: job },
          upsert: true
        }
      }));

      const result = await jobsCollection.bulkWrite(ops);

      newJobsCount = result.upsertedCount;

      console.log(`[6/7] New jobs: ${newJobsCount}`);
    }

    // 🚀 Crawl detail (limit 5)
    console.log('[7/7] Crawling job detail');

    const pending = await jobsCollection
      .find({ status: 'pending' })
      .limit(5)
      .toArray();

    let completedCount = 0;

    for (const job of pending) {
      try {
        console.log(`[7/7] Crawling ${job.jobId}`);

        await page.goto(job.url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });

        const html = await page.content();

        await jobsCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              fullHtml: html,
              status: 'completed'
            }
          }
        );

        completedCount++;
      } catch (e) {
        console.error(`Error crawl ${job.jobId}`, e.message);
      }
    }

    await sendTelegram(
      `✅ <b>Done</b>\n- Total: ${jobs.length}\n- New: ${newJobsCount}\n- Crawled: ${completedCount}`
    );

    console.log('[DONE]');
  } catch (error) {
    console.error(error);

    await sendTelegram(`❌ <b>Error:</b> ${error.message}`);
  } finally {
    await browser.close();
    await client.close();
  }
}

run();