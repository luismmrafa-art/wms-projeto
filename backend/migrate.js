// ============================================================================
// migrate.js — Migração de esquema (código, não phpMyAdmin manual)
//
// Idempotente: cada passo verifica o estado atual (information_schema) antes
// de alterar, por isso corre-se com segurança várias vezes:
//   node migrate.js
//
// O que introduz:
//   - TiposRobo: catálogo de robôs (capacidade, velocidade, navegação, corredor)
//   - Artigos: dados mestre do SKU (peso, dimensões, fragilidade) por armazém
//   - Produtos.ArtigoID / Encomendas.ArtigoID: FK reais, substituem a ligação
//     frágil por nome (ProdutoNome / Produtos.Nome)
//   - Armazens.LarguraCorredorM / RoboTipoID: layout físico + robô escolhido
//   - TiposRobo.Comprimento/Largura/AlturaCm: medidas físicas reais do robô
//   - Armazens.Prateleira{Largura,Profundidade,AlturaNivel}Cm: tamanho único
//     das prateleiras do armazém, usado para validar se um artigo cabe
// ============================================================================

const mysql = require('mysql2/promise');
require('dotenv').config();

async function colunaExiste(conn, tabela, coluna) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, tabela, coluna]
  );
  return rows[0].n > 0;
}

async function tabelaExiste(conn, tabela) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as n FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [process.env.DB_NAME, tabela]
  );
  return rows[0].n > 0;
}

async function fkExiste(conn, tabela, nomeFk) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as n FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [process.env.DB_NAME, tabela, nomeFk]
  );
  return rows[0].n > 0;
}

async function passo(descricao, fn) {
  process.stdout.write(`- ${descricao}... `);
  const feito = await fn();
  console.log(feito ? 'OK' : 'já existia (ignorado)');
}

async function migrar() {
  const conn = await mysql.createConnection({
    host: process.env.DB_SERVER,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  console.log(`Ligado a ${process.env.DB_NAME}. A migrar...\n`);

  // 0. Limpeza: sem FK real, ficaram registos órfãos de armazéns já apagados
  // (sintoma direto do problema que esta migração resolve). Remove-os antes
  // de introduzir as chaves estrangeiras, para não bloquear a criação.
  await passo('Limpeza de órfãos (produtos/encomendas de armazéns já apagados)', async () => {
    const [op] = await conn.query('DELETE FROM produtos WHERE ArmazemID NOT IN (SELECT ID FROM armazens)');
    const [oe] = await conn.query('DELETE FROM encomendas WHERE ArmazemID NOT IN (SELECT ID FROM armazens)');
    if (op.affectedRows > 0) console.log(`\n  (${op.affectedRows} produtos órfãos removidos)`);
    if (oe.affectedRows > 0) console.log(`  (${oe.affectedRows} encomendas órfãs removidas)`);
    return op.affectedRows > 0 || oe.affectedRows > 0;
  });

  // 1. TiposRobo — catálogo de robôs (Indústria 5.0: cada tipo tem specs reais)
  await passo('Tabela TiposRobo', async () => {
    if (await tabelaExiste(conn, 'TiposRobo')) return false;
    await conn.query(`
      CREATE TABLE TiposRobo (
        ID INT AUTO_INCREMENT PRIMARY KEY,
        Nome VARCHAR(60) NOT NULL,
        CapacidadeCargaKg DECIMAL(6,2) NOT NULL,
        VelocidadeMS DECIMAL(4,2) NOT NULL,
        TipoNavegacao ENUM('trilho_fixo','perimetro','livre') NOT NULL,
        LarguraMinCorredorM DECIMAL(4,2) NOT NULL,
        Descricao VARCHAR(255)
      )
    `);
    return true;
  });

  // Seed do catálogo (4 tipos distintos, só se a tabela estiver vazia)
  await passo('Seed de TiposRobo (4 tipos de referência)', async () => {
    const [existentes] = await conn.query('SELECT COUNT(*) as n FROM TiposRobo');
    if (existentes[0].n > 0) return false;
    await conn.query(`
      INSERT INTO TiposRobo (Nome, CapacidadeCargaKg, VelocidadeMS, TipoNavegacao, LarguraMinCorredorM, Descricao) VALUES
      ('AGV Trilho Fixo', 40.00, 1.50, 'trilho_fixo', 1.00, 'Percurso fixo e previsível; mais barato, menor flexibilidade de layout.'),
      ('AMR Ligeiro', 15.00, 1.20, 'perimetro', 0.80, 'Ágil, para armazéns com corredores estreitos e cargas leves.'),
      ('AMR Pesado', 80.00, 0.80, 'perimetro', 1.20, 'Maior capacidade de carga; mais lento, exige corredores largos.'),
      ('Cobot Colaborativo', 25.00, 0.60, 'livre', 0.60, 'Navegação livre junto ao operador; mais lento, uso em espaços apertados.')
    `);
    return true;
  });

  // 2. Armazens — largura de corredor (layout físico) e robô escolhido
  await passo('Coluna armazens.LarguraCorredorM', async () => {
    if (await colunaExiste(conn, 'armazens', 'LarguraCorredorM')) return false;
    await conn.query(`ALTER TABLE armazens ADD COLUMN LarguraCorredorM DECIMAL(4,2) NOT NULL DEFAULT 1.20`);
    return true;
  });
  await passo('Coluna armazens.RoboTipoID', async () => {
    if (await colunaExiste(conn, 'armazens', 'RoboTipoID')) return false;
    await conn.query(`ALTER TABLE armazens ADD COLUMN RoboTipoID INT NULL`);
    return true;
  });

  // Código de convite: fecha o registo público de operador (qualquer pessoa
  // podia criar conta de Operador em qualquer armazém existente, só sabendo
  // o seu ID). Cada armazém recebe um código gerado, que o gestor partilha
  // com os operadores; o registo passa a exigi-lo.
  await passo('Coluna armazens.CodigoConvite', async () => {
    if (await colunaExiste(conn, 'armazens', 'CodigoConvite')) return false;
    await conn.query(`ALTER TABLE armazens ADD COLUMN CodigoConvite VARCHAR(12) NULL`);
    return true;
  });
  await passo('Backfill de códigos de convite para armazéns existentes', async () => {
    const [semCodigo] = await conn.query('SELECT ID FROM armazens WHERE CodigoConvite IS NULL');
    for (const a of semCodigo) {
      const codigo = Math.random().toString(36).slice(2, 8).toUpperCase();
      await conn.query('UPDATE armazens SET CodigoConvite = ? WHERE ID = ?', [codigo, a.ID]);
    }
    return semCodigo.length > 0;
  });
  await passo('Coluna armazens.CodigoConvite obrigatória e única', async () => {
    if (await fkExiste(conn, 'armazens', 'uq_armazem_codigoconvite')) return false;
    await conn.query(`ALTER TABLE armazens MODIFY COLUMN CodigoConvite VARCHAR(12) NOT NULL`);
    await conn.query(`ALTER TABLE armazens ADD CONSTRAINT uq_armazem_codigoconvite UNIQUE (CodigoConvite)`);
    return true;
  });
  await passo('FK armazens.RoboTipoID -> TiposRobo', async () => {
    if (await fkExiste(conn, 'armazens', 'fk_armazem_robotipo')) return false;
    await conn.query(`ALTER TABLE armazens ADD CONSTRAINT fk_armazem_robotipo FOREIGN KEY (RoboTipoID) REFERENCES TiposRobo(ID)`);
    return true;
  });

  // 3. Artigos — dados mestre do SKU (peso, dimensões, fragilidade)
  await passo('Tabela Artigos', async () => {
    if (await tabelaExiste(conn, 'Artigos')) return false;
    await conn.query(`
      CREATE TABLE Artigos (
        ID INT AUTO_INCREMENT PRIMARY KEY,
        ArmazemID INT NOT NULL,
        Nome VARCHAR(100) NOT NULL,
        PesoKg DECIMAL(6,2) NOT NULL DEFAULT 1.00,
        ComprimentoCm DECIMAL(6,1) NOT NULL DEFAULT 20.0,
        LarguraCm DECIMAL(6,1) NOT NULL DEFAULT 20.0,
        AlturaCm DECIMAL(6,1) NOT NULL DEFAULT 20.0,
        Fragil TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uq_artigo_armazem_nome (ArmazemID, Nome),
        CONSTRAINT fk_artigo_armazem FOREIGN KEY (ArmazemID) REFERENCES armazens(ID)
      )
    `);
    return true;
  });

  // Backfill: cria um Artigo por cada nome distinto já usado em Produtos/Encomendas
  await passo('Backfill de Artigos a partir de produtos/encomendas existentes', async () => {
    const [distintos] = await conn.query(`
      SELECT ArmazemID, Nome FROM produtos
      UNION
      SELECT ArmazemID, ProdutoNome as Nome FROM encomendas WHERE ProdutoNome IS NOT NULL
    `);
    if (distintos.length === 0) return false;
    let inseridos = 0;
    for (const d of distintos) {
      const [existe] = await conn.query('SELECT ID FROM Artigos WHERE ArmazemID = ? AND Nome = ?', [d.ArmazemID, d.Nome]);
      if (existe.length > 0) continue;
      await conn.query('INSERT INTO Artigos (ArmazemID, Nome) VALUES (?, ?)', [d.ArmazemID, d.Nome]);
      inseridos++;
    }
    return inseridos > 0;
  });

  // 4. Produtos.ArtigoID — liga a unidade física ao artigo (substitui o nome solto)
  await passo('Coluna produtos.ArtigoID', async () => {
    if (await colunaExiste(conn, 'produtos', 'ArtigoID')) return false;
    await conn.query(`ALTER TABLE produtos ADD COLUMN ArtigoID INT NULL`);
    return true;
  });
  await passo('Backfill de produtos.ArtigoID', async () => {
    const [res] = await conn.query(`
      UPDATE produtos p
      JOIN Artigos a ON a.ArmazemID = p.ArmazemID AND a.Nome = p.Nome
      SET p.ArtigoID = a.ID
      WHERE p.ArtigoID IS NULL
    `);
    return res.affectedRows > 0;
  });
  await passo('FK produtos.ArtigoID -> Artigos', async () => {
    if (await fkExiste(conn, 'produtos', 'fk_produto_artigo')) return false;
    await conn.query(`ALTER TABLE produtos MODIFY COLUMN ArtigoID INT NOT NULL`);
    await conn.query(`ALTER TABLE produtos ADD CONSTRAINT fk_produto_artigo FOREIGN KEY (ArtigoID) REFERENCES Artigos(ID)`);
    return true;
  });

  // 5. Encomendas.ArtigoID — a crítica central do orientador: já não liga por nome
  await passo('Coluna encomendas.ArtigoID', async () => {
    if (await colunaExiste(conn, 'encomendas', 'ArtigoID')) return false;
    await conn.query(`ALTER TABLE encomendas ADD COLUMN ArtigoID INT NULL`);
    return true;
  });
  await passo('Backfill de encomendas.ArtigoID', async () => {
    const [res] = await conn.query(`
      UPDATE encomendas e
      JOIN Artigos a ON a.ArmazemID = e.ArmazemID AND a.Nome = e.ProdutoNome
      SET e.ArtigoID = a.ID
      WHERE e.ArtigoID IS NULL
    `);
    return res.affectedRows > 0;
  });
  await passo('FK encomendas.ArtigoID -> Artigos', async () => {
    if (await fkExiste(conn, 'encomendas', 'fk_encomenda_artigo')) return false;
    await conn.query(`ALTER TABLE encomendas MODIFY COLUMN ArtigoID INT NOT NULL`);
    await conn.query(`ALTER TABLE encomendas ADD CONSTRAINT fk_encomenda_artigo FOREIGN KEY (ArtigoID) REFERENCES Artigos(ID)`);
    return true;
  });

  // 6. Dimensões físicas dos robôs (comprimento/largura/altura) — até aqui só
  // existia a largura mínima de corredor exigida; agora ficam também as
  // medidas reais do robô, para se perceber o porquê desse mínimo e para
  // futuras verificações de encaixe (ex.: robô vs. largura da prateleira).
  await passo('Colunas TiposRobo.ComprimentoCm / LarguraCm / AlturaCm', async () => {
    if (await colunaExiste(conn, 'TiposRobo', 'ComprimentoCm')) return false;
    await conn.query(`ALTER TABLE TiposRobo
      ADD COLUMN ComprimentoCm DECIMAL(6,1) NULL,
      ADD COLUMN LarguraCm DECIMAL(6,1) NULL,
      ADD COLUMN AlturaCm DECIMAL(6,1) NULL`);
    return true;
  });
  await passo('Backfill das medidas dos 4 robôs de referência', async () => {
    const medidas = {
      'AGV Trilho Fixo': [80, 60, 120],
      'AMR Ligeiro': [50, 40, 100],
      'AMR Pesado': [100, 80, 150],
      'Cobot Colaborativo': [45, 45, 110],
    };
    let alterados = 0;
    for (const [nome, [c, l, a]] of Object.entries(medidas)) {
      const [res] = await conn.query(
        'UPDATE TiposRobo SET ComprimentoCm = ?, LarguraCm = ?, AlturaCm = ? WHERE Nome = ? AND ComprimentoCm IS NULL',
        [c, l, a, nome]
      );
      alterados += res.affectedRows;
    }
    // Robôs sem medidas conhecidas (adicionados manualmente): valor por omissão
    // conservador, para nunca ficarem NULL e partirem a validação de encaixe.
    const [res2] = await conn.query('UPDATE TiposRobo SET ComprimentoCm = 60, LarguraCm = 50, AlturaCm = 120 WHERE ComprimentoCm IS NULL');
    alterados += res2.affectedRows;
    if (alterados > 0) {
      await conn.query(`ALTER TABLE TiposRobo
        MODIFY COLUMN ComprimentoCm DECIMAL(6,1) NOT NULL,
        MODIFY COLUMN LarguraCm DECIMAL(6,1) NOT NULL,
        MODIFY COLUMN AlturaCm DECIMAL(6,1) NOT NULL`);
    }
    return alterados > 0;
  });

  // 7. Tamanho único das prateleiras por armazém — simplifica o layout (todas
  // as prateleiras de um armazém têm o mesmo footprint) e permite validar, na
  // entrada de stock, que um artigo cabe fisicamente (secção seguinte).
  await passo('Colunas armazens.Prateleira{Largura,Profundidade,AlturaNivel}Cm', async () => {
    if (await colunaExiste(conn, 'armazens', 'PrateleiraLarguraCm')) return false;
    await conn.query(`ALTER TABLE armazens
      ADD COLUMN PrateleiraLarguraCm DECIMAL(6,1) NOT NULL DEFAULT 100.0,
      ADD COLUMN PrateleiraProfundidadeCm DECIMAL(6,1) NOT NULL DEFAULT 60.0,
      ADD COLUMN PrateleiraAlturaNivelCm DECIMAL(6,1) NOT NULL DEFAULT 40.0`);
    return true;
  });

  console.log('\nMigração concluída.');
  await conn.end();
}

migrar().catch(e => {
  console.error('\nERRO na migração:', e.message);
  process.exit(1);
});
