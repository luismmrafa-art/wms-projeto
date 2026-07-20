const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // Para criar/verificar os tokens de login
const pool = require('./db'); // Agora chama o pool do MySQL
const { planearRecolha, calcularDistanciasTarefa } = require('./coordenacao'); // BFS: distâncias e rotas
const { obterOuCriarArtigo, resolverArtigoID, caberNaPrateleira } = require('./artigos'); // Dados mestre do artigo (peso, dimensões, frágil)
const { listarTiposRobo, recomendarRobo, VELOCIDADE_HUMANO_MS } = require('./robos'); // Catálogo e recomendação de robôs (SAD)
const { avaliarTarefa } = require('./custoDecisao'); // Decisão multicritério humano/robô
const { compararAlgoritmos } = require('./algoritmos'); // Os 3 algoritmos: exato, guloso, meta-heurística
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


// Tarefas de picking pendentes de um armazém, com os atributos do artigo
// (peso/dimensões/frágil) já ligados por ArtigoID — reutilizada pelo endpoint
// do operador (app) e pelo planeamento em lote (comparação dos 3 algoritmos).
async function buscarTarefasPendentes(armazemID) {
    const sql = `
        SELECT
            e.ID as TarefaID,
            a.Nome as Nome,
            e.Quantidade,
            a.PesoKg, a.Fragil, a.ComprimentoCm, a.LarguraCm, a.AlturaCm,
            p.PosX,
            p.PosY,
            pr.Nivel
        FROM Encomendas e
        JOIN Artigos a ON a.ID = e.ArtigoID
        LEFT JOIN Produtos pr ON pr.ArtigoID = e.ArtigoID AND pr.ArmazemID = e.ArmazemID
        LEFT JOIN Prateleiras p ON pr.PrateleiraID = p.ID
        WHERE e.Estado = 'Pendente' AND e.ArmazemID = ?
        GROUP BY e.ID
    `;
    const [tarefas] = await pool.query(sql, [armazemID]);
    return tarefas.map(t => ({ ...t, Produto: t.Nome, PesoKg: Number(t.PesoKg) }));
}

// 📱 APP DO OPERADOR: Buscar lista de tarefas
app.get('/api/tarefas/pendentes', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente
        const tarefas = await buscarTarefasPendentes(armazemID);

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
        // 📦 Junta os atributos do artigo (peso, dimensões, frágil) via ArtigoID
        const [produtos] = await pool.query(`
            SELECT p.*, a.PesoKg, a.Fragil, a.ComprimentoCm, a.LarguraCm, a.AlturaCm
            FROM Produtos p
            JOIN Artigos a ON a.ID = p.ArtigoID
            WHERE p.ArmazemID = ?
        `, [armazemId]);

        res.json({ prateleiras, produtos });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao carregar o mapa.' });
    }
});


// Rota para o Dashboard: Dar entrada de um Produto Novo
app.post('/api/produtos/novo', verificarToken, async (req, res) => {
    try {
        const { nome, posX, posY, nivel, pesoKg, comprimentoCm, larguraCm, alturaCm, fragil } = req.body;
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

        // 3. Valida que o artigo cabe fisicamente na prateleira deste armazém.
        // Todas as prateleiras de um armazém têm o mesmo tamanho (Armazens.Prateleira*),
        // pelo que a comparação é sempre contra esse tamanho único, não por prateleira.
        const dimsArtigo = {
            comprimentoCm: comprimentoCm !== undefined ? parseFloat(comprimentoCm) : 20,
            larguraCm: larguraCm !== undefined ? parseFloat(larguraCm) : 20,
            alturaCm: alturaCm !== undefined ? parseFloat(alturaCm) : 20,
        };
        const [armazemRows] = await pool.query(
            'SELECT PrateleiraLarguraCm, PrateleiraProfundidadeCm, PrateleiraAlturaNivelCm FROM Armazens WHERE ID = ?',
            [armazemID]
        );
        const dimsPrateleira = {
            larguraCm: Number(armazemRows[0]?.PrateleiraLarguraCm ?? 100),
            profundidadeCm: Number(armazemRows[0]?.PrateleiraProfundidadeCm ?? 60),
            alturaNivelCm: Number(armazemRows[0]?.PrateleiraAlturaNivelCm ?? 40),
        };
        if (!caberNaPrateleira(dimsArtigo, dimsPrateleira)) {
            return res.status(400).json({
                erro: `Este artigo (${dimsArtigo.comprimentoCm}×${dimsArtigo.larguraCm}×${dimsArtigo.alturaCm} cm) não cabe nas prateleiras deste armazém ` +
                      `(máximo ${dimsPrateleira.larguraCm}×${dimsPrateleira.profundidadeCm} cm de base, ${dimsPrateleira.alturaNivelCm} cm de altura por nível).`
            });
        }

        // 4. Regista/atualiza o artigo (peso, dimensões, frágil) — dados mestre do SKU
        const artigo = await obterOuCriarArtigo(pool, {
            armazemID, nome,
            pesoKg: pesoKg !== undefined ? parseFloat(pesoKg) : undefined,
            comprimentoCm: dimsArtigo.comprimentoCm,
            larguraCm: dimsArtigo.larguraCm,
            alturaCm: dimsArtigo.alturaCm,
            fragil: fragil !== undefined ? !!fragil && fragil !== 'false' && fragil !== '0' : undefined,
        });

        // 5. Insere uma linha por cada unidade (INSERT múltiplo), ligada ao artigo por FK
        const valores = Array.from({ length: quantidade }, () => [nome, prateleira.ID, nivel, armazemID, artigo.ID]);
        await pool.query(
            'INSERT INTO Produtos (Nome, PrateleiraID, Nivel, ArmazemID, ArtigoID) VALUES ?',
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

        // 1. Cria o armazém novo, com um código de convite único (para os
        // operadores se poderem registar — ver /api/operador/registo)
        const codigoConvite = Math.random().toString(36).slice(2, 8).toUpperCase();
        const [resArmazem] = await conn.query(
            'INSERT INTO Armazens (Nome, Cidade, CodigoConvite) VALUES (?, ?, ?)',
            [nomeArmazem, cidade || null, codigoConvite]
        );
        const armazemID = resArmazem.insertId;

        // 2. Cria a conta de Gestor ligada a esse armazém
        const senhaHash = await bcrypt.hash(senha, 12);
        await conn.query(
            'INSERT INTO Usuarios (Nome, Email, Senha, Cargo, ArmazemID) VALUES (?, ?, ?, "Gestor", ?)',
            [nome, email, senhaHash, armazemID]
        );

        await conn.commit();
        res.status(201).json({
            mensagem: `Armazém "${nomeArmazem}" criado! Já podes fazer login como Gestor.`,
            codigoConvite,
        });
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
        const { nome, email, senha, armazemID, codigoConvite } = req.body;

        if (!nome || !email || !senha || !armazemID || !codigoConvite) {
            return res.status(400).json({ erro: 'Preenche todos os campos, escolhe um armazém e indica o código de convite (pede-o ao gestor).' });
        }

        // 🔒 O armazém tem de existir E o código de convite tem de coincidir
        // (fecha o registo público: sem o código, não se cria conta neste armazém).
        const [armazem] = await pool.query('SELECT ID FROM Armazens WHERE ID = ? AND CodigoConvite = ?', [armazemID, String(codigoConvite).trim().toUpperCase()]);
        if (armazem.length === 0) {
            return res.status(403).json({ erro: 'Armazém não encontrado ou código de convite incorreto.' });
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
        const { produtoNome, armazemID } = req.body;
        if (!armazemID) return res.status(400).json({ erro: 'Falta o armazém.' });

        // Liga a encomenda ao artigo por ArtigoID (FK), não só pelo nome
        const artigoID = await resolverArtigoID(pool, armazemID, produtoNome);
        await pool.query('INSERT INTO Encomendas (ProdutoNome, ArtigoID, Estado, ArmazemID) VALUES (?, ?, "Pendente", ?)', [produtoNome, artigoID, armazemID]);

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

        // As encomendas vêm do simulador ERP (não há cliente individual associado).
        const sql = `
            SELECT e.ID, 'Simulador ERP' AS Cliente, e.ProdutoNome, e.Estado, e.Data
            FROM Encomendas e
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
        // Resolve o ArtigoID de cada nome uma única vez (cria o artigo se for novo, com valores por omissão)
        const artigoIDPorNome = {};
        for (let item of carrinho) {
            artigoIDPorNome[item.nome] = await resolverArtigoID(conn, armazemID, item.nome);
        }

        for (let item of carrinho) {
            const artigoID = artigoIDPorNome[item.nome];
            // Stock físico no armazém
            const [stock] = await conn.query(
                'SELECT COUNT(*) as total FROM Produtos WHERE ArtigoID = ? AND ArmazemID = ? FOR UPDATE',
                [artigoID, armazemID]
            );
            // Quantidade já comprometida em encomendas ainda Pendentes (reservada, mas não recolhida)
            const [reservado] = await conn.query(
                "SELECT COALESCE(SUM(Quantidade), 0) as total FROM Encomendas WHERE ArtigoID = ? AND ArmazemID = ? AND Estado = 'Pendente'",
                [artigoID, armazemID]
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

        for (let item of carrinho) {
            await conn.query(
                'INSERT INTO Encomendas (ProdutoNome, ArtigoID, Quantidade, Estado, Data, ArmazemID) VALUES (?, ?, ?, "Pendente", NOW(), ?)',
                [item.nome, artigoIDPorNome[item.nome], item.qtd, armazemID]
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

        const [enc] = await conn.query('SELECT ProdutoNome, ArtigoID, Quantidade, ArmazemID FROM Encomendas WHERE ID = ? FOR UPDATE', [encomendaId]);
        if (enc.length === 0) {
            await conn.rollback();
            return res.status(404).json({ erro: 'Encomenda não encontrada' });
        }

        const { ProdutoNome, ArtigoID, Quantidade, ArmazemID } = enc[0];

        // 🔒 Garante que a encomenda pertence ao armazém deste operador (vem do token)
        if (ArmazemID !== req.utilizador.armazemID) {
            await conn.rollback();
            return res.status(403).json({ erro: 'Esta encomenda não pertence ao teu armazém.' });
        }

        // 🔗 Localiza a unidade física pelo ArtigoID (FK), não pelo nome
        const [posicao] = await conn.query(`
            SELECT p.PosX, p.PosY
            FROM Produtos prod
            JOIN Prateleiras p ON prod.PrateleiraID = p.ID
            WHERE prod.ArtigoID = ? AND prod.ArmazemID = ? LIMIT 1
        `, [ArtigoID, ArmazemID]);

        const [stock] = await conn.query(
            'SELECT COUNT(*) as total FROM Produtos WHERE ArtigoID = ? AND ArmazemID = ? FOR UPDATE',
            [ArtigoID, ArmazemID]
        );

        if (stock[0].total < Quantidade) {
            await conn.query('UPDATE Encomendas SET Estado = "Rutura de Stock" WHERE ID = ?', [encomendaId]);
            await conn.commit();
            return res.status(400).json({ erro: `RUTURA! A encomenda pede ${Quantidade}x ${ProdutoNome}, mas só tens ${stock[0].total}.` });
        }

        await conn.query(`DELETE FROM Produtos WHERE ArtigoID = ? AND ArmazemID = ? LIMIT ${Number(Quantidade)}`, [ArtigoID, ArmazemID]);
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

// 🤝 COORDENAÇÃO HUMANO-MÁQUINA (Indústria 5.0)
// Dado um produto, calcula o ponto de encontro entre o operador e o robô virtual
// e as rotas de ambos (algoritmo exato BFS), com métricas de eficiência.
app.get('/api/coordenacao/plano', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID; // 🔒 do token
        const produtoNome = req.query.produto;

        // 1. Determina a prateleira-alvo: pela posição (clique no mapa) ou pelo produto
        let alvoX = parseInt(req.query.posX);
        let alvoY = parseInt(req.query.posY);
        if (!Number.isInteger(alvoX) || !Number.isInteger(alvoY)) {
            const [pos] = await pool.query(`
                SELECT p.PosX, p.PosY
                FROM Produtos prod
                JOIN Prateleiras p ON prod.PrateleiraID = p.ID
                WHERE prod.ArtigoID = (SELECT ID FROM Artigos WHERE Nome = ? AND ArmazemID = ?) AND prod.ArmazemID = ? LIMIT 1
            `, [produtoNome, armazemID, armazemID]);
            if (pos.length === 0) {
                return res.status(404).json({ erro: 'Produto não encontrado em nenhuma prateleira deste armazém.' });
            }
            alvoX = pos[0].PosX; alvoY = pos[0].PosY;
        }

        // 2. Carrega a planta do armazém (prateleiras) e as dimensões da grelha
        const [prateleiras] = await pool.query('SELECT PosX, PosY FROM Prateleiras WHERE ArmazemID = ?', [armazemID]);
        const [configs] = await pool.query('SELECT * FROM Configuracoes');
        let maxX = prateleiras.reduce((m, p) => Math.max(m, p.PosX), 1);
        let maxY = prateleiras.reduce((m, p) => Math.max(m, p.PosY), 1);
        configs.forEach(c => {
            if (c.Chave === 'largura') maxX = Math.max(maxX, c.Valor);
            if (c.Chave === 'comprimento') maxY = Math.max(maxY, c.Valor);
        });

        // 3. Calcula o plano de coordenação (ponto de encontro + rotas + métricas)
        const plano = planearRecolha({ prateleiras, maxX, maxY, alvoX, alvoY });
        if (plano.erro) return res.status(400).json({ erro: plano.erro });

        // 4. Características do artigo nesta prateleira (peso/dimensões/frágil)
        const [artigoRows] = await pool.query(`
            SELECT a.* FROM Produtos prod
            JOIN Prateleiras p ON prod.PrateleiraID = p.ID
            JOIN Artigos a ON a.ID = prod.ArtigoID
            WHERE p.PosX = ? AND p.PosY = ? AND prod.ArmazemID = ? LIMIT 1
        `, [alvoX, alvoY, armazemID]);
        const artigo = artigoRows[0] || null;

        // 5. Robô: o escolhido pelo gestor para este armazém, ou o recomendado (SAD)
        const [armazemRows] = await pool.query('SELECT LarguraCorredorM, RoboTipoID FROM Armazens WHERE ID = ?', [armazemID]);
        const armazem = armazemRows[0] || { LarguraCorredorM: 1.2, RoboTipoID: null };
        const tiposRobo = await listarTiposRobo(pool);
        let robo = armazem.RoboTipoID ? (tiposRobo.find(r => r.ID === armazem.RoboTipoID) || null) : null;
        if (!robo) {
            robo = recomendarRobo({ tiposRobo, larguraCorredorM: Number(armazem.LarguraCorredorM), tarefas: artigo ? [artigo] : [] }).recomendado;
        }

        // 6. Decisão multicritério: humano sozinho vs. humano+robô (não só distância)
        const decisao = avaliarTarefa({
            distanciaOperadorAteEncontro: plano.metricas.operadorComCarga,
            distanciaRoboAteEncontro: plano.metricas.roboAteEncontro,
            distanciaOperadorSemRobo: plano.metricas.operadorSemRobo,
            velocidadeHumanoMS: VELOCIDADE_HUMANO_MS,
            robo,
            artigo: artigo || { PesoKg: 1, Fragil: 0 },
        });

        res.json({ produto: produtoNome || null, artigo, robo, decisao, ...plano });
    } catch (erro) {
        console.error('Erro na coordenação:', erro);
        res.status(500).json({ erro: 'Erro ao calcular a coordenação.' });
    }
});


// 🔑 CÓDIGO DE CONVITE deste armazém, para o gestor partilhar com os operadores
app.get('/api/armazem/codigo-convite', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT CodigoConvite FROM Armazens WHERE ID = ?', [req.utilizador.armazemID]);
        res.json({ codigoConvite: rows[0]?.CodigoConvite || null });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao carregar o código de convite.' });
    }
});

// 🔍 PROCURAR ARTIGO: devolve os atributos (peso/dimensões/frágil) de um artigo já
// existente neste armazém, para o formulário de entrada de stock não repor os
// valores por omissão quando se arruma mais uma unidade de um artigo já conhecido.
app.get('/api/artigos/procurar', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID;
        const nome = req.query.nome;
        const [rows] = await pool.query('SELECT PesoKg, ComprimentoCm, LarguraCm, AlturaCm, Fragil FROM Artigos WHERE ArmazemID = ? AND Nome = ?', [armazemID, nome]);
        res.json(rows[0] || null);
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao procurar o artigo.' });
    }
});

// ⚙️ CONFIGURAÇÃO DO ARMAZÉM: largura do corredor (usada na recomendação de
// robô) e, opcionalmente, o robô fixado manualmente pelo gestor.
app.get('/api/armazem/config', verificarToken, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT LarguraCorredorM, RoboTipoID, PrateleiraLarguraCm, PrateleiraProfundidadeCm, PrateleiraAlturaNivelCm FROM Armazens WHERE ID = ?',
            [req.utilizador.armazemID]
        );
        res.json(rows[0] || { LarguraCorredorM: 1.2, RoboTipoID: null, PrateleiraLarguraCm: 100, PrateleiraProfundidadeCm: 60, PrateleiraAlturaNivelCm: 40 });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao carregar a configuração do armazém.' });
    }
});

app.post('/api/armazem/config', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID;
        const { larguraCorredorM, roboTipoID, prateleiraLarguraCm, prateleiraProfundidadeCm, prateleiraAlturaNivelCm } = req.body;

        const largura = parseFloat(larguraCorredorM);
        if (!Number.isFinite(largura) || largura <= 0) {
            return res.status(400).json({ erro: 'A largura do corredor tem de ser um número positivo.' });
        }

        const prLargura = parseFloat(prateleiraLarguraCm);
        const prProfundidade = parseFloat(prateleiraProfundidadeCm);
        const prAltura = parseFloat(prateleiraAlturaNivelCm);
        if (![prLargura, prProfundidade, prAltura].every(v => Number.isFinite(v) && v > 0)) {
            return res.status(400).json({ erro: 'As dimensões da prateleira têm de ser números positivos.' });
        }

        // roboTipoID vazio/nulo = deixar a recomendação automática decidir
        const roboID = (roboTipoID === '' || roboTipoID === null || roboTipoID === undefined) ? null : parseInt(roboTipoID);
        if (roboID !== null) {
            const [tipo] = await pool.query('SELECT ID FROM TiposRobo WHERE ID = ?', [roboID]);
            if (tipo.length === 0) return res.status(404).json({ erro: 'Esse tipo de robô não existe.' });
        }

        await pool.query(
            `UPDATE Armazens SET LarguraCorredorM = ?, RoboTipoID = ?,
               PrateleiraLarguraCm = ?, PrateleiraProfundidadeCm = ?, PrateleiraAlturaNivelCm = ?
             WHERE ID = ?`,
            [largura, roboID, prLargura, prProfundidade, prAltura, armazemID]
        );
        res.json({ mensagem: 'Configuração do armazém guardada!' });
    } catch (erro) {
        console.error('Erro a guardar configuração do armazém:', erro);
        res.status(500).json({ erro: 'Erro ao guardar a configuração do armazém.' });
    }
});

// 🤖 CATÁLOGO DE ROBÔS: tipos disponíveis, com as suas especificações reais
app.get('/api/robos/tipos', verificarToken, async (req, res) => {
    try {
        const tipos = await listarTiposRobo(pool);
        res.json(tipos);
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao carregar o catálogo de robôs.' });
    }
});

// 🤖 RECOMENDAÇÃO DE ROBÔ (SAD): dado o layout deste armazém (largura do
// corredor) e as tarefas pendentes, recomenda o tipo de robô mais adequado.
app.get('/api/robos/recomendar', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID;
        const [armazemRows] = await pool.query('SELECT LarguraCorredorM FROM Armazens WHERE ID = ?', [armazemID]);
        const larguraCorredorM = Number(armazemRows[0]?.LarguraCorredorM ?? 1.2);

        const tiposRobo = await listarTiposRobo(pool);
        const tarefas = await buscarTarefasPendentes(armazemID);

        const resultado = recomendarRobo({ tiposRobo, larguraCorredorM, tarefas });
        res.json(resultado);
    } catch (erro) {
        console.error('Erro na recomendação de robô:', erro);
        res.status(500).json({ erro: 'Erro ao calcular a recomendação de robô.' });
    }
});

// 🧮 PLANEAMENTO EM LOTE: corre os 3 algoritmos (exato, guloso, meta-heurística)
// sobre as tarefas pendentes deste armazém e devolve os resultados lado a
// lado, para comparar tempo de cálculo e qualidade da solução (relatório, cap. 13).
app.get('/api/planeamento/otimizar', verificarToken, async (req, res) => {
    try {
        const armazemID = req.utilizador.armazemID;

        const [prateleiras] = await pool.query('SELECT PosX, PosY FROM Prateleiras WHERE ArmazemID = ?', [armazemID]);
        const [configs] = await pool.query('SELECT * FROM Configuracoes');
        let maxX = prateleiras.reduce((m, p) => Math.max(m, p.PosX), 1);
        let maxY = prateleiras.reduce((m, p) => Math.max(m, p.PosY), 1);
        configs.forEach(c => {
            if (c.Chave === 'largura') maxX = Math.max(maxX, c.Valor);
            if (c.Chave === 'comprimento') maxY = Math.max(maxY, c.Valor);
        });

        const todasTarefas = await buscarTarefasPendentes(armazemID);
        // Só é possível planear geometricamente as que têm posição de prateleira conhecida.
        const tarefas = todasTarefas.filter(t => Number.isInteger(t.PosX) && Number.isInteger(t.PosY));
        const semLocalizacao = todasTarefas.length - tarefas.length;

        const [armazemRows] = await pool.query('SELECT LarguraCorredorM, RoboTipoID FROM Armazens WHERE ID = ?', [armazemID]);
        const armazem = armazemRows[0] || { LarguraCorredorM: 1.2, RoboTipoID: null };
        const tiposRobo = await listarTiposRobo(pool);
        let robo = armazem.RoboTipoID ? (tiposRobo.find(r => r.ID === armazem.RoboTipoID) || null) : null;
        if (!robo) {
            robo = recomendarRobo({ tiposRobo, larguraCorredorM: Number(armazem.LarguraCorredorM), tarefas }).recomendado;
        }

        const ctx = { prateleiras, maxX, maxY, deposito: undefined, robo, velocidadeHumanoMS: VELOCIDADE_HUMANO_MS };
        const resultado = compararAlgoritmos(tarefas, ctx);

        res.json({ totalTarefas: tarefas.length, semLocalizacao, robo, ...resultado });
    } catch (erro) {
        console.error('Erro no planeamento em lote:', erro);
        res.status(500).json({ erro: 'Erro ao comparar os algoritmos de planeamento.' });
    }
});

// 📂 IMPORTAR MAPA: Substitui TODA a planta do armazém (apaga a antiga primeiro)
app.post('/api/armazem/importar', verificarToken, async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { prateleiras } = req.body;
        const armazemID = req.utilizador.armazemID; // 🔒 do token, não do cliente

        // Verifica se o que foi enviado é mesmo uma lista
        if (!Array.isArray(prateleiras)) {
            return res.status(400).json({ erro: 'Formato inválido. O ficheiro deve conter uma lista de prateleiras.' });
        }

        await conn.beginTransaction();

        // 1. Reset: apaga produtos e prateleiras antigas deste armazém (evita sobreposição)
        const [prodApagados] = await conn.query('DELETE FROM Produtos WHERE ArmazemID = ?', [armazemID]);
        const [pratApagadas] = await conn.query('DELETE FROM Prateleiras WHERE ArmazemID = ?', [armazemID]);

        // 2. Constrói as prateleiras novas (ignora duplicados dentro do próprio ficheiro)
        const vistas = new Set();
        let inseridas = 0;
        for (let plat of prateleiras) {
            const chave = `${plat.posX},${plat.posY}`;
            if (vistas.has(chave)) continue; // mesma posição repetida no ficheiro
            vistas.add(chave);

            await conn.query(
                'INSERT INTO Prateleiras (PosX, PosY, Niveis, ArmazemID) VALUES (?, ?, ?, ?)',
                [plat.posX, plat.posY, plat.niveis, armazemID]
            );
            inseridas++;
        }

        await conn.commit();
        res.status(201).json({
            mensagem: `Planta carregada! ${inseridas} prateleiras criadas (removidas ${pratApagadas.affectedRows} antigas e ${prodApagados.affectedRows} produtos).`
        });
    } catch (erro) {
        await conn.rollback();
        console.error("Erro a importar JSON:", erro);
        res.status(500).json({ erro: 'Erro interno ao construir o armazém.' });
    } finally {
        conn.release();
    }
});

// Inicia o servidor na porta definida (3000 por defeito)
const porta = process.env.PORT || 3000;
app.listen(porta, () => {
    console.log(`🚀 Servidor a correr na porta ${porta}`);
});