CREATE TABLE `WechatOfferSubscription` (
    `id` INTEGER NOT NULL,
    `credential` BLOB NULL,
    `authorizedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `accountId` VARCHAR(80) NULL,
    `accountName` VARCHAR(120) NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `lastAttempt` DATETIME(3) NULL,
    `lastSuccess` DATETIME(3) NULL,
    `error` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
