const mysql = require('mysql2/promise');
require('dotenv').config();

// Configura o "pool" de ligações à base de dados usando as variáveis do .env
const pool = mysql.createPool({
    host: process.env.DB_SERVER,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Testa a ligação inicial para garantir que as credenciais funcionam
pool.getConnection()
    .then(connection => {
        console.log('✅ Ligado ao MySQL (phpMyAdmin) com sucesso!');
        connection.release();
    })
    .catch(err => {
        console.log('❌ Erro a ligar ao MySQL: ', err.message);
    });

// Exporta o pool para ser utilizado noutros ficheiros da API
module.exports = pool;