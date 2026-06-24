const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db'); // Agora chama o pool do MySQL
require('dotenv').config();

// 🤖 Memória Global do Radar (Guarda a última posição do robô para cada Armazém)
let radarRobo = {};

const app = express();

// Middlewares essenciais para a API funcionar (CORS para permissões, JSON para ler o body, static para ficheiros front-end)
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rota para importar o Mapa (JSON)
app.post('/api/mapa/importar', async (req, res) => {
    try {
        const layout = req.body; 

        // Limpa a tabela antes de importar o novo mapa
        await pool.query('DELETE FROM Prateleiras');

        // Itera sobre o JSON e insere cada prateleira individualmente
        for (let i = 0; i < layout.prateleiras.length; i++) {
            const prat = layout.prateleiras[i];
            
            await pool.query(
                'INSERT INTO Prateleiras (PosX, PosY, Niveis) VALUES (?, ?, ?)',
                [prat.x, prat.y, prat.niveis]
            );
        }

        res.status(200).json({ 
            mensagem: 'Mapa importado com sucesso!',
            totalPrateleiras: layout.prateleiras.length
        });

    } catch (erro) {
        console.log('Erro ao importar mapa:', erro);
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});


// 📱 APP DO OPERADOR: Buscar lista de tarefas
app.get('/api/tarefas/pendentes', async (req, res) => {
    try {
        const armazemID = req.query.armazemID;

        const sql = `
            SELECT 
                e.ID as TarefaID, 
                e.ProdutoNome as Produto, 
                e.Quantidade, 
                p.PosX, 
                p.PosY, 
                pr.Nivel
            FROM Encomendas e
            JOIN Produtos pr ON e.ProdutoNome = pr.Nome AND e.ArmazemID = pr.ArmazemID
            JOIN Prateleiras p ON pr.PrateleiraID = p.ID
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

// Rota para a App Móvel: Confirmar que o produto foi apanhado
app.post('/api/tarefas/confirmar', async (req, res) => {
    try {
        const idDaTarefa = req.body.tarefaID; 

        // Altera o estado da linha da encomenda para "Recolhido"
        const [resultado] = await pool.query(
            'UPDATE EncomendaLinhas SET Recolhido = 1 WHERE ID = ?', 
            [idDaTarefa]
        );

        if (resultado.affectedRows === 0) {
            return res.status(404).json({ erro: 'Tarefa não encontrada.' });
        }

        res.status(200).json({ 
            mensagem: `Boa! Produto da tarefa ${idDaTarefa} apanhado com sucesso.` 
        });

    } catch (erro) {
        console.log('Erro ao confirmar tarefa:', erro);
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});



// 📦 INVENTÁRIO: O Filtro Mágico (Só envia as prateleiras do armazém certo)
app.get('/api/inventario', async (req, res) => {
    try {
        const armazemId = req.query.armazemID; // Lê a chave que vem do URL
        
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
app.post('/api/produtos/novo', async (req, res) => {
    try {
        const { nome, posX, posY, nivel, armazemID } = req.body;

        console.log(`📦 Tentar arrumar: [${nome}] no X:${posX}, Y:${posY}, Nível:${nivel} do Armazém:${armazemID}`);

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

        // 3. Associa o produto à prateleira encontrada E ao Armazém 🔐
        await pool.query(
            'INSERT INTO Produtos (Nome, PrateleiraID, Nivel, ArmazemID) VALUES (?, ?, ?, ?)', 
            [nome, prateleira.ID, nivel, armazemID]
        );

        res.status(200).json({ mensagem: 'Produto guardado com sucesso!' });

    } catch (erro) {
        console.log('Erro ao guardar produto:', erro);
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});

// 🔨 CRIAR PRATELEIRA
app.post('/api/prateleiras/nova', async (req, res) => {
    try {
        // Agora recebe também o armazemID
        const { posX, posY, niveis, armazemID } = req.body; 
        
        await pool.query(
            'INSERT INTO Prateleiras (PosX, PosY, Niveis, ArmazemID) VALUES (?, ?, ?, ?)', 
            [posX, posY, niveis, armazemID]
        );
        res.status(201).json({ mensagem: 'Prateleira construída!' });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao criar prateleira.' });
    }
});


// Rota para Apagar um Produto
app.delete('/api/produtos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log("Tentando apagar o produto com ID:", id); // Isto ajuda a ver no terminal
        
        await pool.query('DELETE FROM Produtos WHERE ID = ?', [id]);
        
        res.status(200).json({ mensagem: 'Produto removido com sucesso!' });
    } catch (erro) {
        console.error("Erro no MySQL:", erro);
        res.status(500).json({ erro: 'Erro interno ao apagar produto' });
    }
});

// Rota para Apagar uma Prateleira (SÓ SE ESTIVER VAZIA)
app.delete('/api/prateleiras/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Verifica se existem produtos associados a esta prateleira antes de permitir apagar
        const [produtos] = await pool.query('SELECT ID FROM Produtos WHERE PrateleiraID = ?', [id]);
        
        if (produtos.length > 0) {
            return res.status(400).json({ erro: 'Não podes apagar uma prateleira que ainda tem produtos lá dentro!' });
        }

        await pool.query('DELETE FROM Prateleiras WHERE ID = ?', [id]);
        res.status(200).json({ mensagem: 'Prateleira removida!' });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro ao apagar prateleira' });
    }
});

// Buscar o tamanho guardado
app.get('/api/config/tamanho', async (req, res) => {
    const [configs] = await pool.query('SELECT * FROM Configuracoes');
    const tamanho = {};
    configs.forEach(c => tamanho[c.Chave] = c.Valor);
    res.json(tamanho);
});

// Guardar novo tamanho
app.post('/api/config/tamanho', async (req, res) => {
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

        res.status(200).json({
            mensagem: `Bem-vindo, ${utilizador.Nome}!`,
            cargo: utilizador.Cargo,
            armazemId: utilizador.ArmazemID,
            redirecionar: utilizador.Cargo === 'Gestor' ? '/index.html' : '/operador.html'
        });
    } catch (erro) {
        res.status(500).json({ erro: 'Erro interno no servidor' });
    }
});

// 📝 ROTA DE REGISTO: Criar conta de Cliente
app.post('/api/registo', async (req, res) => {
    try {
        const { nome, email, senha } = req.body;

        // Validação para evitar emails duplicados
        const [existe] = await pool.query('SELECT ID FROM Usuarios WHERE Email = ?', [email]);
        if (existe.length > 0) {
            return res.status(400).json({ erro: 'Este email já está em uso! Tenta fazer login.' });
        }

        const senhaHash = await bcrypt.hash(senha, 12);

        // Força o cargo a "Cliente" por defeito no registo público
        await pool.query(
            'INSERT INTO Usuarios (Nome, Email, Senha, Cargo) VALUES (?, ?, ?, "Cliente")',
            [nome, email, senhaHash]
        );

        res.status(200).json({ mensagem: 'Conta criada com sucesso! Bem-vindo à WMS Store.' });
    } catch (erro) {
        console.error("Erro no registo:", erro);
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
app.get('/api/gestor/encomendas', async (req, res) => {
    try {
        const armazemId = req.query.armazemID;

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


// 🤖 SIMULADOR: Gerar ordem de picking (Como se viesse de um ERP como o SAP)
app.post('/api/encomendas/simular', async (req, res) => {
    try {
        const { nome, armazemID } = req.body;

        // Para não dar erro na Base de Dados, atribuímos a encomenda ao dono do armazém (o Gestor)
        const [usuarios] = await pool.query("SELECT ID FROM Usuarios WHERE ArmazemID = ? LIMIT 1", [armazemID]);
        const clienteDeTesteID = usuarios.length > 0 ? usuarios[0].ID : 1; 

        // Cria a encomenda
        await pool.query(
            'INSERT INTO Encomendas (ClienteID, ProdutoNome, Estado, Data, ArmazemID) VALUES (?, ?, "Pendente", NOW(), ?)', 
            [clienteDeTesteID, nome, armazemID]
        );

        res.status(201).json({ mensagem: 'Ordem gerada!' });
    } catch (erro) {
        console.error(erro);
        res.status(500).json({ erro: 'Erro ao gerar encomenda.' });
    }
});



// 🛒 SIMULADOR: Receber um Carrinho de Compras (COM VALIDAÇÃO DE STOCK 🛡️)
app.post('/api/encomendas/carrinho', async (req, res) => {
    const conn = await pool.getConnection();
    try {
        const { carrinho, armazemID } = req.body;

        await conn.beginTransaction();

        for (let item of carrinho) {
            const [stock] = await conn.query(
                'SELECT COUNT(*) as total FROM Produtos WHERE Nome = ? AND ArmazemID = ? FOR UPDATE',
                [item.nome, armazemID]
            );
            if (stock[0].total < item.qtd) {
                await conn.rollback();
                return res.status(400).json({
                    erro: `Operação Bloqueada! Tentaste encomendar ${item.qtd}x "${item.nome}", mas só tens ${stock[0].total} em stock físico no armazém.`
                });
            }
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
app.post('/api/operador/concluir', async (req, res) => {
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
app.get('/api/robo/radar', (req, res) => {
    const armazemID = req.query.armazemID;
    const dados = radarRobo[armazemID] || null;
    res.json(dados);
});


// 📂 IMPORTAR MAPA: Receber array JSON e criar estrutura
app.post('/api/armazem/importar', async (req, res) => {
    try {
        const { prateleiras, armazemID } = req.body;

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