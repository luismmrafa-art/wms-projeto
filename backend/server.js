const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Para criar/verificar os tokens de login
const pool = require('./db'); // Agora chama o pool do MySQL
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET; // Segredo que assina os tokens (vem do .env)

// 🤖 Memória Global do Radar (Guarda a última posição do robô para cada Armazém)
let radarRobo = {};

const app = express();

// Middlewares essenciais para a API funcionar (CORS para permissões, JSON para ler o body, static para ficheiros front-end)
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 🛡️ GUARDA: middleware que exige um token válido para aceder à rota.
// Lê o cabeçalho "Authorization: Bearer <token>", confirma a assinatura e
// guarda os dados do utilizador em req.utilizador para as rotas usarem.
function verificarToken(req, res, next) {
    const cabecalho = req.headers['authorization'];
    const token = cabecalho && cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;

    if (!token) {
        return res.status(401).json({ erro: 'Sem autorização. Faz login primeiro.' });
    }

    try {
        req.utilizador = jwt.verify(token, JWT_SECRET);
        next();
    } catch (erro) {
        return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faz login de novo.' });
    }
}

// Cria um token assinado com os dados essenciais do utilizador (válido 8 horas)
function gerarToken(utilizador) {
    return jwt.sign(
        { id: utilizador.id, cargo: utilizador.cargo, armazemID: utilizador.armazemID },
        JWT_SECRET,
        { expiresIn: '8h' }
    );
}


// 📱 APP DO OPERADOR: Buscar lista de tarefas
app.get('/api/tarefas/pendentes', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente

        const sql = `
            SELECT 
                e.ID as TarefaID, 
                e.ProdutoNome as Produto, 
                e.Quantidade, 
                p.PosX, 
                p.PosY, 
                pr.Nivel
            FROM Encomendas e
            LEFT JOIN Produtos pr ON e.ProdutoNome = pr.Nome AND e.ArmazemID = pr.ArmazemID
            LEFT JOIN Prateleiras p ON pr.PrateleiraID = p.ID
            WHERE e.Estado = 'Pendente' AND e.ArmazemID = ?
            GROUP BY e.ID
        `;
        
        const [tarefas] = await pool.query(sql, [armazemID]);
        
        // 🚨 CORREÇÃO: Devolvemos sempre a lista (mesmo que esteja vazia) para o Flutter ficar feliz!
        res.json(tarefas); 

    } catch (erro) {
        console.error("🚨 Erro a buscar tarefas:", erro.message);
        res.status(500).json({ erro: 'Erro no servidor' });
    }
});




// 📦 INVENTÁRIO: O Filtro Mágico (Só envia as prateleiras do armazém certo)
app.get('/api/inventario', verificarToken, async (req, res) => {
    try {
        const armazemId = req.utilizador.armazemID; // 🔒 do token, não do cliente
        
        if (!armazemId) {
            return res.status(400).json({ erro: 'Falta o ID do armazém.' });
        }

        // Filtramos com WHERE ArmazemID = ?
        const [prateleiras] = await pool.query('SELECT * FROM Prateleiras WHERE ArmazemID = ?', [armazemId]);
        const [produtos] = await pool.query('SELECT * FROM Produtos WHERE ArmazemID = ?', [armazemId]);
        
        res.json({ prateleiras, produtos });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao carregar o mapa.' });
    }
});


// Rota para o Dashboard: Dar entrada de um Produto Novo
app.post('/api/produtos/novo', verificarToken, async (req, res) => {
    try {
        const { nome, posX, posY, nivel } = req.body;
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente

        // Quantidade de unidades a arrumar (1 por defeito). Cada unidade é uma linha.
        const quantidade = parseInt(req.body.quantidade) || 1;
        if (quantidade < 1 || quantidade > 1000) {
            return res.status(400).json({ erro: 'A quantidade tem de estar entre 1 e 1000.' });
        }

        console.log(`📦 Tentar arrumar: ${quantidade}x [${nome}] no X:${posX}, Y:${posY}, Nível:${nivel} do Armazém:${armazemID}`);

        // 1. Encontra a prateleira pelas coordenadas E pelo Armazém 🔐
        const [prateleiras] = await pool.query(
            'SELECT ID, Niveis FROM Prateleiras WHERE PosX = ? AND PosY = ? AND ArmazemID = ?',
            [posX, posY, armazemID]
        );

        if (prateleiras.length === 0) {
            return res.status(404).json({ erro: 'Não existe nenhuma prateleira nessas coordenadas neste armazém!' });
        }

        const prateleira = prateleiras[0];

        // 2. Valida se o nível (andar) especificado é válido para essa prateleira
        if (nivel > prateleira.Niveis || nivel < 1) {
            return res.status(400).json({ erro: `Essa prateleira só tem ${prateleira.Niveis} andares!` });
        }

        // 3. Insere uma linha por cada unidade (INSERT múltiplo)
        const valores = Array.from({ length: quantidade }, () => [nome, prateleira.ID, nivel, armazemID]);
        await pool.query(
            'INSERT INTO Produtos (Nome, PrateleiraID, Nivel, ArmazemID) VALUES ?',
            [valores]
        );

        res.status(200).json({ mensagem: `${quantidade}x "${nome}" guardado(s) com sucesso!` });

    } catch (erro) {
        console.log('Erro ao guardar produto:', erro);
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});

// 🔨 CRIAR PRATELEIRA
app.post('/api/prateleiras/nova', verificarToken, async (req, res) => {
    try {
        // Agora recebe também o armazemID
        const { posX, posY, niveis } = req.body;
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente
        
        await pool.query(
            'INSERT INTO Prateleiras (PosX, PosY, Niveis, ArmazemID) VALUES (?, ?, ?, ?)', 
            [posX, posY, niveis, armazemID]
        );
        res.status(201).json({ mensagem: 'Prateleira construída!' });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao criar prateleira.' });
    }
});


// Rota para Apagar um Produto (só do próprio armazém)
app.delete('/api/produtos/:id', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;

        // 🔒 Só apaga se o produto for do armazém deste utilizador (vem do token)
        const [resultado] = await pool.query(
            'DELETE FROM Produtos WHERE ID = ? AND ArmazemID = ?',
            [id, req.utilizador.armazemID]
        );

        if (resultado.affectedRows === 0) {
            return res.status(404).json({ erro: 'Produto não encontrado neste armazém.' });
        }

        res.status(200).json({ mensagem: 'Produto removido com sucesso!' });
    } catch (erro) {
        console.error("Erro no MySQL:", erro);
        res.status(500).json({ erro: 'Erro interno ao apagar produto' });
    }
});

// Rota para Apagar uma Prateleira (só do próprio armazém E só se estiver vazia)
app.delete('/api/prateleiras/:id', verificarToken, async (req, res) => {
    try {
        const { id } = req.params;
        const armazemID = req.utilizador.armazemID;

        // 🔒 Confirma que a prateleira é deste armazém (vem do token)
        const [prateleira] = await pool.query('SELECT ID FROM Prateleiras WHERE ID = ? AND ArmazemID = ?', [id, armazemID]);
        if (prateleira.length === 0) {
            return res.status(404).json({ erro: 'Prateleira não encontrada neste armazém.' });
        }

        // Verifica se existem produtos associados a esta prateleira antes de permitir apagar
        const [produtos] = await pool.query('SELECT ID FROM Produtos WHERE PrateleiraID = ?', [id]);
        if (produtos.length > 0) {
            return res.status(400).json({ erro: 'Não podes apagar uma prateleira que ainda tem produtos lá dentro!' });
        }

        await pool.query('DELETE FROM Prateleiras WHERE ID = ? AND ArmazemID = ?', [id, armazemID]);
        res.status(200).json({ mensagem: 'Prateleira removida!' });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao apagar prateleira' });
    }
});

// Buscar o tamanho guardado
app.get('/api/config/tamanho', verificarToken, async (req, res) => {
    const [configs] = await pool.query('SELECT * FROM Configuracoes');
    const tamanho = {};
    configs.forEach(c => tamanho[c.Chave] = c.Valor);
    res.json(tamanho);
});

// Guardar novo tamanho
app.post('/api/config/tamanho', verificarToken, async (req, res) => {
    const { largura, comprimento } = req.body;
    await pool.query('UPDATE Configuracoes SET Valor = ? WHERE Chave = "largura"', [largura]);
    await pool.query('UPDATE Configuracoes SET Valor = ? WHERE Chave = "comprimento"', [comprimento]);
    res.json({ mensagem: 'Tamanho guardado!' });
});


// 🚪 LOGIN: Agora devolve a Chave do Armazém
app.post('/api/login', async (req, res) => {
    try {
        const { email, senha } = req.body;

        const [utilizadores] = await pool.query(
            'SELECT ID, Nome, Cargo, ArmazemID, Senha FROM Usuarios WHERE Email = ?',
            [email]
        );

        if (utilizadores.length === 0) {
            return res.status(401).json({ erro: 'Email ou Senha incorretos!' });
        }

        const utilizador = utilizadores[0];
        const senhaCorreta = await bcrypt.compare(senha, utilizador.Senha);

        if (!senhaCorreta) {
            return res.status(401).json({ erro: 'Email ou Senha incorretos!' });
        }

        // Gera o "bilhete" (token) que o frontend vai guardar e enviar nos próximos pedidos
        const token = gerarToken({ id: utilizador.ID, cargo: utilizador.Cargo, armazemID: utilizador.ArmazemID });

        res.status(200).json({
            mensagem: `Bem-vindo, ${utilizador.Nome}!`,
            token: token,
            cargo: utilizador.Cargo,
            armazemId: utilizador.ArmazemID,
            redirecionar: utilizador.Cargo === 'Gestor' ? '/index.html' : '/operador.html'
        });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});

// 📝 ROTA DE REGISTO (WEB): Cria um Armazém NOVO + a conta de Gestor desse armazém
app.post('/api/registo', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { nome, email, senha, nomeArmazem, cidade } = req.body;

        // Validação dos campos obrigatórios
        if (!nome || !email || !senha || !nomeArmazem) {
            return res.status(400).json({ erro: 'Preenche o teu nome, email, password e o nome do armazém.' });
        }

        // Validação para evitar emails duplicados
        const [existe] = await conn.query('SELECT ID FROM Usuarios WHERE Email = ?', [email]);
        if (existe.length > 0) {
            return res.status(400).json({ erro: 'Este email já está em uso! Tenta fazer login.' });
        }

        await conn.beginTransaction();

        // 1. Cria o armazém novo
        const [resArmazem] = await conn.query(
            'INSERT INTO Armazens (Nome, Cidade) VALUES (?, ?)',
            [nomeArmazem, cidade || null]
        );
        const armazemID = resArmazem.insertId;

        // 2. Cria a conta de Gestor ligada a esse armazém
        const senhaHash = await bcrypt.hash(senha, 12);
        await conn.query(
            'INSERT INTO Usuarios (Nome, Email, Senha, Cargo, ArmazemID) VALUES (?, ?, ?, "Gestor", ?)',
            [nome, email, senhaHash, armazemID]
        );

        await conn.commit();
        res.status(201).json({ mensagem: `Armazém "${nomeArmazem}" criado! Já podes fazer login como Gestor.` });
    } catch (erro) {
        await conn.rollback();
        console.error("Erro no registo:", erro);
        res.status(500).json({ erro: 'Erro interno no servidor ao criar conta.' });
    } finally {
        conn.release();
    }
});

// 🏬 LISTAR ARMAZÉNS: Usado pelo app Flutter para o operador escolher onde se liga
app.get('/api/armazens', async (req, res) => {
    try {
        const [armazens] = await pool.query('SELECT ID, Nome, Cidade FROM Armazens ORDER BY Nome');
        res.json(armazens);
    } catch (erro) {
        console.error("Erro ao listar armazéns:", erro);
        res.status(500).json({ erro: 'Erro ao carregar armazéns.' });
    }
});

// 👷 REGISTO DE OPERADOR (FLUTTER): Cria conta de Operador ligada a um armazém EXISTENTE
// Vários operadores podem partilhar o mesmo ArmazemID.
app.post('/api/operador/registo', async (req, res) => {
    try {
        const { nome, email, senha, armazemID } = req.body;

        if (!nome || !email || !senha || !armazemID) {
            return res.status(400).json({ erro: 'Preenche todos os campos e escolhe um armazém.' });
        }

        // O armazém escolhido tem de existir
        const [armazem] = await pool.query('SELECT ID FROM Armazens WHERE ID = ?', [armazemID]);
        if (armazem.length === 0) {
            return res.status(404).json({ erro: 'Esse armazém não existe.' });
        }

        // Email único
        const [existe] = await pool.query('SELECT ID FROM Usuarios WHERE Email = ?', [email]);
        if (existe.length > 0) {
            return res.status(400).json({ erro: 'Este email já está em uso! Tenta fazer login.' });
        }

        const senhaHash = await bcrypt.hash(senha, 12);
        await pool.query(
            'INSERT INTO Usuarios (Nome, Email, Senha, Cargo, ArmazemID) VALUES (?, ?, ?, "Operador", ?)',
            [nome, email, senhaHash, armazemID]
        );

        res.status(201).json({ mensagem: 'Conta de operador criada! Já podes fazer login.' });
    } catch (erro) {
        console.error("Erro no registo de operador:", erro);
        res.status(500).json({ erro: 'Erro interno no servidor ao criar conta.' });
    }
});



// 🛒 ROTA DA LOJA: Mostrar os produtos que existem no armazém
app.get('/api/loja/produtos', async (req, res) => {
    try {
        // Agrupa os produtos por nome e conta quantos existem em stock
        const [produtos] = await pool.query('SELECT Nome, COUNT(ID) as Quantidade FROM Produtos GROUP BY Nome');
        res.json(produtos);
    } catch (erro) {
        console.error("Erro na Loja:", erro);
        res.status(500).json({ erro: 'Erro ao carregar a loja' });
    }
});

// 🛍️ ROTA DA LOJA: O cliente clica em "Comprar"
app.post('/api/loja/comprar', async (req, res) => {
    try {
        const { clienteEmail, produtoNome } = req.body; 

        const [clientes] = await pool.query('SELECT ID FROM Usuarios WHERE Email = ?', [clienteEmail]);
        if (clientes.length === 0) return res.status(400).json({ erro: 'Cliente não encontrado' });
        const clienteID = clientes[0].ID;

        // Guarda a encomenda e O QUE o cliente comprou
        await pool.query('INSERT INTO Encomendas (ClienteID, ProdutoNome, Estado) VALUES (?, ?, "Pendente")', [clienteID, produtoNome]);
        
        res.status(200).json({ mensagem: `Boa! Compraste um ${produtoNome}. O armazém já foi avisado!` });
    } catch (erro) {
        console.error("Erro na Compra:", erro);
        res.status(500).json({ erro: 'Erro ao processar compra' });
    }
});

// 📊 TABELA DO GESTOR (Versão Final e Estável)
app.get('/api/gestor/encomendas', verificarToken, async (req, res) => {
    try {
        const armazemId = req.utilizador.armazemID; // 🔒 do token, não do cliente

        // Fazemos um JOIN para ir buscar o Nome do utilizador que corresponde ao ClienteID
        const sql = `
            SELECT e.ID, u.Nome as Cliente, e.ProdutoNome, e.Estado, e.Data 
            FROM Encomendas e
            JOIN Usuarios u ON e.ClienteID = u.ID
            WHERE e.ArmazemID = ? 
            ORDER BY e.Data DESC 
            LIMIT 10
        `;
        const [encomendas] = await pool.query(sql, [armazemId]);
        res.json(encomendas);

    } catch (erro) {
        console.error("🚨 ERRO NAS VENDAS:", erro.message);
        res.status(500).json({ erro: 'Erro ao carregar histórico' });
    }
});




// 🛒 SIMULADOR: Receber um Carrinho de Compras (COM VALIDAÇÃO DE STOCK 🛡️)
app.post('/api/encomendas/carrinho', verificarToken, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { carrinho } = req.body;
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente

        await conn.beginTransaction();

        // Guarda o que já foi reservado dentro deste próprio carrinho (caso o mesmo produto apareça 2x)
        const reservadoNesteCarrinho = {};

        for (let item of carrinho) {
            // Stock físico no armazém
            const [stock] = await conn.query(
                'SELECT COUNT(*) as total FROM Produtos WHERE Nome = ? AND ArmazemID = ? FOR UPDATE',
                [item.nome, armazemID]
            );
            // Quantidade já comprometida em encomendas ainda Pendentes (reservada, mas não recolhida)
            const [reservado] = await conn.query(
                "SELECT COALESCE(SUM(Quantidade), 0) as total FROM Encomendas WHERE ProdutoNome = ? AND ArmazemID = ? AND Estado = 'Pendente'",
                [item.nome, armazemID]
            );

            const disponivel = stock[0].total - reservado[0].total - (reservadoNesteCarrinho[item.nome] || 0);

            if (disponivel < item.qtd) {
                await conn.rollback();
                return res.status(400).json({
                    erro: `Operação Bloqueada! Tentaste encomendar ${item.qtd}x "${item.nome}", mas só tens ${disponivel} disponível (stock físico menos encomendas pendentes).`
                });
            }

            reservadoNesteCarrinho[item.nome] = (reservadoNesteCarrinho[item.nome] || 0) + item.qtd;
        }

        const [usuarios] = await conn.query("SELECT ID FROM Usuarios WHERE ArmazemID = ? LIMIT 1", [armazemID]);
        const clienteID = usuarios.length > 0 ? usuarios[0].ID : 1;

        for (let item of carrinho) {
            await conn.query(
                'INSERT INTO Encomendas (ClienteID, ProdutoNome, Quantidade, Estado, Data, ArmazemID) VALUES (?, ?, ?, "Pendente", NOW(), ?)',
                [clienteID, item.nome, item.qtd, armazemID]
            );
        }

        await conn.commit();
        res.status(201).json({ mensagem: 'Carrinho processado e validado com sucesso!' });
    } catch (erro) {
        await conn.rollback();
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao gerar ordens' });
    } finally {
        conn.release();
    }
});

// 👷 BAIXA DE STOCK (Agora controla o Robô!)
app.post('/api/operador/concluir', verificarToken, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { encomendaId } = req.body;

        await conn.beginTransaction();

        const [enc] = await conn.query('SELECT ProdutoNome, Quantidade, ArmazemID FROM Encomendas WHERE ID = ? FOR UPDATE', [encomendaId]);
        if (enc.length === 0) {
            await conn.rollback();
            return res.status(404).json({ erro: 'Encomenda não encontrada' });
        }

        const { ProdutoNome, Quantidade, ArmazemID } = enc[0];

        // 🔒 Garante que a encomenda pertence ao armazém deste operador (vem do token)
        if (ArmazemID !== req.utilizador.armazemID) {
            await conn.rollback();
            return res.status(403).json({ erro: 'Esta encomenda não pertence ao teu armazém.' });
        }

        const [posicao] = await conn.query(`
            SELECT p.PosX, p.PosY
            FROM Produtos prod
            JOIN Prateleiras p ON prod.PrateleiraID = p.ID
            WHERE prod.Nome = ? AND prod.ArmazemID = ? LIMIT 1
        `, [ProdutoNome, ArmazemID]);

        const [stock] = await conn.query(
            'SELECT COUNT(*) as total FROM Produtos WHERE Nome = ? AND ArmazemID = ? FOR UPDATE',
            [ProdutoNome, ArmazemID]
        );

        if (stock[0].total < Quantidade) {
            await conn.query('UPDATE Encomendas SET Estado = "Rutura de Stock" WHERE ID = ?', [encomendaId]);
            await conn.commit();
            return res.status(400).json({ erro: `RUTURA! A encomenda pede ${Quantidade}x ${ProdutoNome}, mas só tens ${stock[0].total}.` });
        }

        await conn.query(`DELETE FROM Produtos WHERE Nome = ? AND ArmazemID = ? LIMIT ${Number(Quantidade)}`, [ProdutoNome, ArmazemID]);
        await conn.query('UPDATE Encomendas SET Estado = "Expedida" WHERE ID = ?', [encomendaId]);

        await conn.commit();

        if (posicao.length > 0) {
            radarRobo[ArmazemID] = {
                posX: posicao[0].PosX,
                posY: posicao[0].PosY,
                timestamp: Date.now()
            };
        }

        res.json({ mensagem: 'Recolha confirmada com sucesso!' });
    } catch (erro) {
        await conn.rollback();
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao dar baixa.' });
    } finally {
        conn.release();
    }
});

// 📡 ROTA DO RADAR: O site vai chamar isto de 2 em 2 segundos
app.get('/api/robo/radar', verificarToken, (req, res) => {
    const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente
    const dados = radarRobo[armazemID] || null;
    res.json(dados);
});


// 📂 IMPORTAR MAPA: Receber array JSON e criar estrutura
app.post('/api/armazem/importar', verificarToken, async (req, res) => {
    try {
        const { prateleiras } = req.body;
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente

        // Verifica se o que foi enviado é mesmo uma lista
        if (!Array.isArray(prateleiras)) {
            return res.status(400).json({ erro: 'Formato inválido. O ficheiro deve conter uma lista de prateleiras.' });
        }

        // Loop: Constrói as prateleiras uma a uma
        for (let plat of prateleiras) {
            // Verifica se a posição já está ocupada naquele armazém
            const [existe] = await pool.query(
                'SELECT ID FROM Prateleiras WHERE PosX = ? AND PosY = ? AND ArmazemID = ?', 
                [plat.posX, plat.posY, armazemID]
            );
            
            // Se não existir nada lá, insere!
            if (existe.length === 0) {
                await pool.query(
                    'INSERT INTO Prateleiras (PosX, PosY, Niveis, ArmazemID) VALUES (?, ?, ?, ?)', 
                    [plat.posX, plat.posY, plat.niveis, armazemID]
                );
            }
        }

        res.status(201).json({ mensagem: 'Planta do armazém carregada!' });
    } catch (erro) {
        console.error("Erro a importar JSON:", erro);
        res.status(500).json({ erro: 'Erro interno ao construir o armazém.' });
    }
});

// Inicia o servidor na porta definida (3000 por defeito)
const porta = process.env.PORT || 3000;
app.listen(porta, () => {
    console.log(`🚀 Servidor a correr na porta ${porta}`);
});