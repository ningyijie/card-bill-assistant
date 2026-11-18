CREATE TABLE `AnnualFeeReview` (
    `cardId` INTEGER NOT NULL,
    `period` VARCHAR(7) NOT NULL,
    `currency` VARCHAR(8) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    PRIMARY KEY (`cardId`, `period`, `currency`),
    CONSTRAINT `AnnualFeeReview_cardId_fkey` FOREIGN KEY (`cardId`) REFERENCES `Card` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
