// index.js (Node.js version of the FastAPI logic)
const { neon } = require('@neondatabase/serverless');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const yahooFinance = require('yahoo-finance2').default;
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { RSI } = require("technicalindicators");
const jwt = require('jsonwebtoken')
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");


require('dotenv').config()
const app = express();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const PORT = process.env.PORT
const JWT_SECRET = process.env.JWT_SECRET
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(cors());
app.use(express.json());

// DB connection
const sql = neon(process.env.DATABASE_URL)

app.post("/register", async (req, res) => {
  try {
   const { username, email, password } = req.body;
    
     const newUser = await sql`
      INSERT INTO users (username, email, password)
      VALUES (${username}, ${email}, ${password})
    `;
    res.status(201).json({ message: "✅ Registered successfully"});

  } catch (err) {
    console.error("❌ Register error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { loginEmail, token} = req.body;
    
    // 1. Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    if (decodedToken.email !== loginEmail) {
      return res.status(401).json({ error: "Invalid login credentials" });
    }
      res.status(200).json({ message: "✅ Login successful"});
  } catch (err) {
    console.error("❌ Login error:", err.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});


app.post("/username", async (req, res) => {
  try {
    const { user } = req.body; // user = email
    const result = await sql`
      SELECT username FROM users WHERE email = ${user}
    `;

    if (result.length === 0) {
      console.log('User not found')
      return res.status(404).json({ message: "User not found" });
    }
    return res.json({ username: result[0].username });
  } catch (err) {
    console.error("❌ Error fetching username:", err.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

async function getRSI(symbol) {
  try {
    // Get historical data (last 30 days, daily)
    const period1 = new Date();
    period1.setDate(period1.getDate() - 30);

    const results = await yahooFinance.chart(symbol, {
      period1,
      interval: "1d",
    });

    // Extract closing prices
    const closes = results.quotes.map(q => q.close);

    // Calculate RSI (14 periods by default)
    const rsiValues = RSI.calculate({ values: closes, period: 14 });

    // Last RSI value (most recent)
    const latestRSI = rsiValues[rsiValues.length - 1];

    console.log(`RSI for ${symbol}:`, latestRSI);
    return latestRSI;
  } catch (err) {
    console.error("Error fetching RSI:", err);
  }
}



//Add digital products
app.post("/add_stock", async (req, res) => {
  try {
    const data = req.body;
    // Count how many stocks this user already has
    const stocks = await sql`
      SELECT * FROM stocks WHERE "user" = ${data.user}
    `;
    // If user already has 10 stocks, check if they are subscribed
    if (stocks.length === 10) {
      const subscriptions = await sql`
        SELECT * FROM subscriptions WHERE "user" = ${data.user}
      `;

      if (subscriptions.length === 0) {
        return res.json({ error: "You have to subscribe in order to add more stocks" });
      }
    }

    // Check if the stock already exists for this user
    const existingStock = await sql`
      SELECT shares FROM stocks WHERE "Symbol" = ${data.symbol} AND "user" = ${data.user}
    `;

    if (existingStock.length > 0) {
      // Update shares if stock exists
      await sql`
        UPDATE stocks
        SET shares = shares + ${data.shares}
        WHERE "Symbol" = ${data.symbol} AND "user" = ${data.user}
      `;
      return res.status(200).json({ message: "Shares updated successfully" });
    } else {
      // Insert new stock if it doesn't exist
      await sql`
        INSERT INTO stocks ("Name", "Symbol", "Type", shares, "buyPrice", "user")
        VALUES (${data.name}, ${data.symbol}, ${data.sector}, ${data.shares}, ${data.buyPrice}, ${data.user})
      `;
      return res.status(200).json({ message: "Added stock successfully" });
    }
  } catch (err) {
    console.error("❌ Error in /add_stock:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/stocks", async (req, res) => {
  try {
    const data = req.body;

    // Fetch all stocks for this user
    const results = await sql`
      SELECT * FROM stocks WHERE "user" = ${data.user}
    `;

    const stock = [];
    let totalPortfolioValue = 0;
    let totalProfitLoss = 0

    for (let i = 0; i < results.length; i++) {
      const quoteData = await yahooFinance.quote(results[i].Symbol);

      const symbol = quoteData.symbol;
      const currentPrice = quoteData.regularMarketPrice;
      const currency = quoteData.currency;
      const priceChange = quoteData.regularMarketChangePercent;
      const name = quoteData.shortName;
      const type = quoteData.quoteType;
      const totalValue = currentPrice * results[i].shares;
      const profitLoss = (currentPrice - results[i].buyPrice) * results[i].shares
      totalPortfolioValue += totalValue;
      totalProfitLoss += profitLoss;

      // ✅ fallback: manually calculate period1 & period2
      const period2 = new Date(); // today
      const period1 = new Date();
      period1.setDate(period1.getDate() - 7); // 7 days ago

      const chart = await yahooFinance.chart(symbol, {
        period1,
        period2,       // last 7 days
        interval: "1d",    // daily candles
      });

      const sparkline = chart.quotes.map((q) => q.close)
      const rsi = await getRSI(symbol)

      stock.push({
        name: name,
        type: type,
        symbol: symbol,
        shares: results[i].shares,
        buyPrice: results[i].buyPrice, // ⚠️ Postgres column names are usually lowercase unless quoted
        currentPrice: currentPrice,
        totalValue: (currentPrice * results[i].shares).toFixed(2),
        profitLoss: ((currentPrice - results[i].buyPrice) * results[i].shares).toFixed(2),
        currency: currency,
        priceChange: priceChange,
        sparkline: sparkline,
        rsi: rsi,
      });
    }

    console.log(stock)
    res.status(200).json({ results: stock, totalPortfolioValue: totalPortfolioValue.toFixed(2), totalProfitLoss: totalProfitLoss.toFixed(2) });
  } catch (err) {
    console.error("❌ Error in /stocks:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


//Update Shares
app.post("/update-shares", async (req, res) => {
  try {
    const { shares, symbol, user } = req.body;

    const result = await sql`
      UPDATE stocks
      SET "shares" = ${shares}
      WHERE "Symbol" = ${symbol} AND "user" = ${user}
      RETURNING *
    `;

    console.log(result)


    res.json({ message: `Updated ${symbol}'s shares successfully!` });
  } catch (err) {
    console.error("❌ Error updating shares:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


// //Update buy price
app.post("/update-buyprice", async (req, res) => {
  try {
    const { buyPrice, symbol, user } = req.body;

    await sql`
      UPDATE stocks
      SET "buyPrice" = ${buyPrice}
      WHERE "Symbol" = ${symbol} AND "user" = ${user}
    `;

    res.json({ message: `Updated ${symbol}'s buy price successfully!` });
  } catch (err) {
    console.error("❌ Error updating buy price:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Delete stock
app.post("/delete-stock", async (req, res) => {
  try {
    const { symbol, user } = req.body;

    await sql`
      DELETE FROM stocks
      WHERE "Symbol" = ${symbol} AND "user" = ${user}
    `;

    res.json({ message: `Deleted ${symbol} successfully!` });
  } catch (err) {
    console.error("❌ Error deleting stock:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

//Search Digital
app.get('/search', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.json(400).json({ message: 'Query is required.' });
  try {
    const results = await yahooFinance.search(query);
    const formatted = results.quotes.map(item => ({
      symbol: item.symbol,
      name: item.shortname,
      type: item.quoteType
    }));
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});




//AI function
async function AI(prompt) {
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'models/gemini-1.5-flash-002' });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    return error.message;
  }
}

// Ai api
app.post('/chat', async (req, res) => {
  const { text } = req.body;

  function getBotResponse(input) {
    const lower = input.toLowerCase();
    if (lower.includes('hello') || lower.includes('hi')) return 'Hi there! I\'m Amani.';
    if (lower.includes('how are you')) return 'I\'m fine. How can I help you today?';
    if (lower.includes('news')) return 'Let me refer you to my fellow agent Millie who would inform you on the latest news and trends and keep you updated. She is available 24/7.';
    return null;
  }

  const botResponse = getBotResponse(text);
  if (botResponse) return res.json({ response: botResponse });

  try {
    const result = await AI(text);
    return res.json({ response: result });
  } catch (e) {
    return res.json({ response: 'Failed to get AI response' });
  }
});

// Format date and time
function formatDate(unixTime) {
  // If timestamp is too small, assume it's in seconds → convert to ms
  const ms = unixTime < 1e12 ? unixTime * 1000 : unixTime;
  const date = new Date(ms);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}


const getGoogleNews = async (symbol) => {
  try {
    const results = await yahooFinance.search(symbol)

    const articles = (results.news || []).map(article => ({
      symbol: symbol,
      title: article.title,
      link: article.link,
      pubDate: formatDate(article.providerPublishTime),
      summary: article.summary || "",
      source: article.provider?.[0]?.name || "Yahoo Finance",

    }))
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 3)

    console.log(articles)
    return articles
  } catch (error) {
    console.error("❌ Error fetching news:", error.message);
    return [];
  }
};

//Load Digital products
async function getStockPrice(symbol) {
  try {
    const quote = await yahooFinance.quote(symbol);
    return {
      symbol: quote.symbol,
      price: quote.regularMarketPrice,
      currency: quote.currency,
      change: quote.regularMarketChangePercent
    };
  } catch (error) {
    return error.message;
  }
}

// AI Advise
app.post("/ai_advise", async (req, res) => {
  try {
    const { user } = req.body;

    // ✅ Check if advice was already given in the last 24 hours
    const [latestAdvice] = await sql`
      SELECT advice, created_at 
      FROM advice_logs 
      WHERE "user" = ${user}
      ORDER BY created_at DESC 
      LIMIT 1
    `;

    if (latestAdvice && new Date() - new Date(latestAdvice.created_at) < 24 * 60 * 60 * 1000) {
      return res.json({
        response: latestAdvice.advice,
        message: "Advice already generated. Wait for 24h to generate a new one.",
      });
    }

    const stocks = [];
    const news = [];

    // Get stocks for user
    const stockResults = await sql`
      SELECT "Symbol", "shares", "buyPrice" 
      FROM stocks 
      WHERE "user" = ${user}
    `;

    for (let i = 0; i < stockResults.length; i++) {
      const stock = stockResults[i];
      const quotes = await getStockPrice(stock.Symbol);
      const period2 = new Date(); // today
      const period1 = new Date();
      period1.setDate(period1.getDate() - 7); // 7 days ago
      const chart = await yahooFinance.chart(stock.Symbol, {
        period1,
        period2,       // last 7 days
        interval: "1h",    // daily candles
      });
      const sparkline = chart.quotes.map((q) => q.close)
      const rsi = await getRSI(stock.Symbol)

      stocks.push({
        symbol: stock.Symbol,
        shares: stock.shares,
        buyPrice: stock.buyPrice,
        quotes,
        sparkline: sparkline,
        rsi: rsi
      });

      // Get news for each stock
      const stockNews = await getGoogleNews(stock.Symbol);
      news.push(stockNews);
    }

    // Get risk assessment
    const riskResults = await sql`
      SELECT * 
      FROM risk 
      WHERE "username" = ${user}
    `;

    // Prepare AI prompt
    const prompt = `
      You are an expert crypto trading advisor. Analyze the following trader profile
      and market factors to provide actionable strategies (entry, exit, risk management).
      
      Format response as structured sections with clear titles. 
      Use this format:
      
      ### Entry & Exit Strategy
      (content here)
      
      ### Risk Management
      (content here)
      
      ### Diversification Tips
      (content here)
      
      ### Market Outlook
      (content here)
      
      ### Portfolio Adjustments
      (content here)
      
      ### Action Plan
      1. Step one
      2. Step two
      3. Step three
      
      Trader Info:
      - Risk Assessment: ${JSON.stringify(riskResults)}
      - Market Sentiment: ${JSON.stringify(news)}
      - Portfolio: ${JSON.stringify(stocks)}
      
      Be concise but practical.
      No Disclaimer.
    `;

    const response = await AI(prompt);

    await sql`
      INSERT INTO advice_logs ("user", advice)
      VALUES (${user}, ${response})
    `;

    console.log(response)
    res.json({ response, message: "New advice generated" });
  } catch (err) {
    console.error("❌ Error in /ai_advise:", err.message);
    res.json({ error: `${err.message}` });
  }
});

//Calculate the risk level
app.post("/calculate_risk", async (req, res) =>{
  const {user} = req.body;
  const stocks = [];
  const news = [];

  // Get stocks for user
    const stockResults = await sql`
      SELECT "Symbol", "shares", "buyPrice" 
      FROM stocks 
      WHERE "user" = ${user}
    `;

    for (let i = 0; i < stockResults.length; i++) {
      const stock = stockResults[i];
      const quotes = await getStockPrice(stock.Symbol);
      const period2 = new Date(); // today
      const period1 = new Date();
      period1.setDate(period1.getDate() - 7); // 7 days ago
      const chart = await yahooFinance.chart(stock.Symbol, {
        period1,
        period2,       // last 7 days
        interval: "1h",    // daily candles
      });
      const sparkline = chart.quotes.map((q) => q.close)
      const rsi = await getRSI(stock.Symbol)

      stocks.push({
        symbol: stock.Symbol,
        shares: stock.shares,
        buyPrice: stock.buyPrice,
        quotes,
        sparkline: sparkline,
        rsi: rsi
      });

       // Get news for each stock
      const stockNews = await getGoogleNews(stock.Symbol);
      news.push(stockNews);
    }

    const riskResults = await sql`
      SELECT * 
      FROM risk 
      WHERE "username" = ${user}
    `;

  //Prompt 
  const prompt = `
  To your best knowledge, based the following resources i want you to calculte my risk level in my tradings:
  1. Stocks selected: ${JSON.stringify(stocks)}
  2. News related to stocks: ${JSON.stringify(news)}
  3. My risk assessment form: ${JSON.stringify(riskResults)}

  Note: the only answer allowed to be given is an integer in pereentage form e.g 53 without the percentage sign. Also it should be a whole number with no decimals.
  `

  const response = await AI(prompt);
  return res.json({response})
})

// News API
app.post("/news", async (req, res) => {
  try {
    const { user } = req.body;

    // Get all stock symbols for this user
    const results = await sql`SELECT "Symbol" FROM stocks WHERE "user" = ${user}`;

    // Fetch news for all symbols in parallel
    const news = await Promise.all(
      results.map(async (row) => await getGoogleNews(row.Symbol))
    );

    // Flatten the array so frontend gets one unified list of articles
    const flatNews = news.flat();

    res.status(200).json({ results: flatNews });
  } catch (err) {
    console.error("❌ Error in /news:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


//Email API
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASSWORD
  }
});

app.post('/send-email', async (req, res) => {
  const { from, message } = req.body;
  try {
    await transporter.sendMail({
      from: from,
      to: 'vincentmahia123@gmail.com',
      subject: `Vinvest Customer: ${from}`,
      text: message
    }, (err, info) => {
      console.error(err)
    });
    res.status(200).json({ message: 'Email Sent successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Email failed to send.' });
  }
});

// Risk Assessment
app.post("/risk", async (req, res) => {
  try {
    const { user, response } = req.body;

    // Check if a record exists for this user
    const existing = await sql`
      SELECT * FROM risk WHERE "username" = ${user}
    `;

    if (existing.length > 0) {
      // Update existing record
      await sql`
        UPDATE risk
        SET age = ${response.age},
            "investmentGoal" = ${response.investmentGoal},
            "investmentTime" = ${response.investmentTime},
            "reactionToMarket" = ${response.reactionToMarket},
            "netWorth" = ${response.netWorth},
            "fundAccess" = ${response.fundAccess},
            "economicOutlook" = ${response.economicOutlook},
            "financialSituation" = ${response.financialSituation},
            "financialObligation" = ${response.financialObligation}
        WHERE "username" = ${user}
      `;
      res.json({ success: "Updated successfully!" });
    } else {
      // Insert new record
      await sql`
        INSERT INTO risk (
          age, "investmentgoal", "investmenttime", "reactiontomarket", "networth",
          "fundaccess", "economicoutlook", "financialsituation", "financialobligation", "username"
        )
        VALUES (
          ${response.age}, ${response.investmentGoal}, ${response.investmentTime},
          ${response.reactionToMarket}, ${response.netWorth}, ${response.fundAccess},
          ${response.economicOutlook}, ${response.financialSituation}, ${response.financialObligation}, ${user}
        )
      `;
      res.json({ success: "Added successfully!" });
    }
  } catch (err) {
    console.error("❌ Error in /risk:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.post("/risk-updated", async (req, res) => {
  try {
    const { user } = req.body;

    // Query with sql template literal (Postgres-safe)
    const results = await sql`
      SELECT * FROM risk WHERE "username" = ${user}
    `;

    if (results.length === 0) {
      return res.json({ risk: true }); // no record → needs update
    } else {
      return res.json({ risk: false }); // record exists → already updated
    }
  } catch (err) {
    console.error("Error checking risk:", err);
    return res.status(500).json({ error: "Database error" });
  }
});

app.post('/porfolio-history', async (req, res) => {
  try {
    const { user } = req.body;
    const history = await sql`SELECT * FROM portfolio_history WHERE "users" = ${user} ORDER BY timestamp ASC`
    res.json(history)
  } catch (error) {
    console.error("❌ Error fetching portfolio history:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
})

//Portfolio history
cron.schedule("0 * * * *", async () => { // once per minute
  console.log("Cron job running at", new Date().toISOString());
  try {
    const users = await sql`SELECT DISTINCT "user" FROM stocks`;

    for (const row of users) {
      const user = row.user;

      const results = await sql`SELECT * FROM stocks WHERE "user" = ${user}`;

      const stockValues = await Promise.all(results.map(async (stock) => {
        const quoteData = await yahooFinance.quote(stock.Symbol);
        return parseFloat((quoteData.regularMarketPrice * stock.shares).toFixed(6));
      }));

      const totalPortfolioValue = parseFloat(stockValues.reduce((a, b) => a + b, 0).toFixed(6));

      await sql`
        INSERT INTO portfolio_history (users, total_value)
        VALUES (${user}, ${totalPortfolioValue})
      `;

      await sql`
        DELETE FROM portfolio_history
        WHERE timestamp < NOW() - INTERVAL '7 days'
      `;
    }
  } catch (err) {
    console.error("❌ Error capturing portfolio history:", err);
  }
});

//Logout endpoint
app.post("/logout", async (req, res) => {
  try {
    const { user } = req.body;

    // Delete user, stocks, and custom entries in sequence
    await sql`DELETE FROM stocks WHERE "user" = ${user}`;
    await sql`DELETE FROM risk WHERE "username" = ${user}`;
    await sql`DELETE FROM advice_logs WHERE "user" = ${user}`;
    await sql`DELETE FROM portfolio_history WHERE "user" = ${user}`
    await sql`DELETE FROM users WHERE email = ${user}`;

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Database error during logout" });
  }
});

app.listen(PORT, () => {
  console.log("Server running on: ${PORT}");

});


































