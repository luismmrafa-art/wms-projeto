// ============================================================================
// artigos.js — Dados mestre do artigo (SKU): peso, dimensões, fragilidade.
//
// Substitui a antiga ligação por nome solto (Produtos.Nome / Encomendas.
// ProdutoNome) por uma tabela própria (Artigos) com chave estrangeira real,
// e é onde vivem as características físicas do pacote que a decisão
// multicritério (custoDecisao.js) precisa: peso, dimensões e fragilidade.
// ============================================================================

// Devolve o artigo (ArmazemID, Nome); cria-o com os atributos dados se ainda
// não existir. Se já existir e forem passados atributos, atualiza-os
// (permite corrigir peso/dimensões numa entrada de stock seguinte).
async function obterOuCriarArtigo(pool, { armazemID, nome, pesoKg, comprimentoCm, larguraCm, alturaCm, fragil }) {
  const [existentes] = await pool.query('SELECT * FROM Artigos WHERE ArmazemID = ? AND Nome = ?', [armazemID, nome]);

  if (existentes.length > 0) {
    const algumAtributo = [pesoKg, comprimentoCm, larguraCm, alturaCm, fragil].some(v => v !== undefined && v !== null);
    if (!algumAtributo) return existentes[0];

    await pool.query(
      `UPDATE Artigos SET
         PesoKg = COALESCE(?, PesoKg), ComprimentoCm = COALESCE(?, ComprimentoCm),
         LarguraCm = COALESCE(?, LarguraCm), AlturaCm = COALESCE(?, AlturaCm),
         Fragil = COALESCE(?, Fragil)
       WHERE ID = ?`,
      [pesoKg ?? null, comprimentoCm ?? null, larguraCm ?? null, alturaCm ?? null, (fragil !== undefined && fragil !== null) ? (fragil ? 1 : 0) : null, existentes[0].ID]
    );
    const [atualizado] = await pool.query('SELECT * FROM Artigos WHERE ID = ?', [existentes[0].ID]);
    return atualizado[0];
  }

  const [res] = await pool.query(
    `INSERT INTO Artigos (ArmazemID, Nome, PesoKg, ComprimentoCm, LarguraCm, AlturaCm, Fragil) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [armazemID, nome, pesoKg ?? 1.0, comprimentoCm ?? 20, larguraCm ?? 20, alturaCm ?? 20, fragil ? 1 : 0]
  );
  const [criado] = await pool.query('SELECT * FROM Artigos WHERE ID = ?', [res.insertId]);
  return criado[0];
}

// Atalho: só o ID, criando o artigo com valores por omissão se for a
// primeira vez que este nome aparece neste armazém (ex.: vindo do simulador
// ERP, que não conhece peso/dimensões).
async function resolverArtigoID(pool, armazemID, nome) {
  const artigo = await obterOuCriarArtigo(pool, { armazemID, nome });
  return artigo.ID;
}

// Verifica se um artigo cabe fisicamente numa prateleira (com rotação no
// plano horizontal — comprimento/largura podem trocar — mas não na vertical,
// já que a altura é limitada pela gravidade e pelo nível de cima).
function caberNaPrateleira({ comprimentoCm, larguraCm, alturaCm }, { larguraCm: prLargura, profundidadeCm: prProfundidade, alturaNivelCm: prAltura }) {
  const encaixaHorizontal =
    (comprimentoCm <= prLargura && larguraCm <= prProfundidade) ||
    (comprimentoCm <= prProfundidade && larguraCm <= prLargura);
  const encaixaAltura = alturaCm <= prAltura;
  return encaixaHorizontal && encaixaAltura;
}

module.exports = { obterOuCriarArtigo, resolverArtigoID, caberNaPrateleira };
