-- Backup das tabelas removidas (estrutura) - 2026-06-25T13:39:02.999Z
-- Geradas vazias; guardado caso precises de recriar.

CREATE TABLE `encomendalinhas` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `EncomendaID` int(11) DEFAULT NULL,
  `ProdutoID` int(11) DEFAULT NULL,
  `Quantidade` int(11) NOT NULL DEFAULT 1,
  `Recolhido` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`ID`),
  KEY `EncomendaID` (`EncomendaID`),
  KEY `encomendalinhas_ibfk_2` (`ProdutoID`),
  CONSTRAINT `encomendalinhas_ibfk_1` FOREIGN KEY (`EncomendaID`) REFERENCES `encomendas` (`ID`),
  CONSTRAINT `encomendalinhas_ibfk_2` FOREIGN KEY (`ProdutoID`) REFERENCES `produtos` (`ID`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `operadores` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `Nome` varchar(50) NOT NULL,
  `Estado` varchar(20) NOT NULL DEFAULT 'LIVRE',
  `UpdatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `robosvirtuais` (
  `ID` int(11) NOT NULL AUTO_INCREMENT,
  `Nome` varchar(50) NOT NULL,
  `Estado` varchar(20) NOT NULL DEFAULT 'LIVRE',
  `PosX` int(11) NOT NULL DEFAULT 0,
  `PosY` int(11) NOT NULL DEFAULT 0,
  `DestX` int(11) DEFAULT NULL,
  `DestY` int(11) DEFAULT NULL,
  `UpdatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

