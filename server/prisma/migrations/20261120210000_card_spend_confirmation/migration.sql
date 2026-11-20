CREATE TABLE `CardSpendConfirmation` (
    `cardId` INTEGER NOT NULL,
    `ruleId` VARCHAR(32) NOT NULL,
    `periodKey` VARCHAR(50) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    PRIMARY KEY (`cardId`, `ruleId`, `periodKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CardSpendConfirmation` ADD CONSTRAINT `CardSpendConfirmation_cardId_fkey`
    FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
