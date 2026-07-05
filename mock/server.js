const express = require('express');
const path = require('path');
const app = express();
const port = 3000;

// Serve static mock pages
app.use(express.static(path.join(__dirname)));

// Emulate ASP.NET route paths mapping to static pages
app.get('/Loginpage.aspx', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/Dashboard.aspx', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/Outsource.aspx', (req, res) => {
    res.sendFile(path.join(__dirname, 'outsource.html'));
});

app.get('/DailyTask.aspx', (req, res) => {
    res.sendFile(path.join(__dirname, 'dailytask.html'));
});

// Fallback to login page for root path
app.get('/', (req, res) => {
    res.redirect('/Loginpage.aspx');
});

app.listen(port, () => {
    console.log(`Mock Server listening at http://localhost:${port}`);
    console.log(`Open http://localhost:${port}/Loginpage.aspx to view mock login page`);
});
