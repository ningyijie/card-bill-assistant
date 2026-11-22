ALTER TABLE `Card` ADD COLUMN `rewardProfile` JSON NULL;

CREATE TABLE `RewardOffer` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `kind` VARCHAR(16) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `rule` JSON NOT NULL,
    `review` VARCHAR(16) NOT NULL DEFAULT 'ready',
    `sourceKey` VARCHAR(191) NULL,
    `fingerprint` VARCHAR(64) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `RewardOffer_sourceKey_key`(`sourceKey`),
    INDEX `RewardOffer_kind_review_idx`(`kind`, `review`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RewardOfferRevision` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `offerId` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `RewardOfferRevision_offerId_changedAt_idx`(`offerId`, `changedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RewardOfferMerchant` (
    `key` VARCHAR(80) NOT NULL,
    `offerId` INTEGER NOT NULL,
    INDEX `RewardOfferMerchant_offerId_idx`(`offerId`),
    PRIMARY KEY (`key`, `offerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CardOfferRecord` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `offerId` INTEGER NOT NULL,
    `cardId` INTEGER NOT NULL,
    `state` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `CardOfferRecord_offerId_cardId_key`(`offerId`, `cardId`),
    INDEX `CardOfferRecord_cardId_idx`(`cardId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RewardSource` (
    `key` VARCHAR(32) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `lastAttempt` DATETIME(3) NULL,
    `lastSuccess` DATETIME(3) NULL,
    `etag` VARCHAR(255) NULL,
    `lastModified` VARCHAR(100) NULL,
    `error` VARCHAR(255) NULL,
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RewardOfferRevision` ADD CONSTRAINT `RewardOfferRevision_offerId_fkey`
  FOREIGN KEY (`offerId`) REFERENCES `RewardOffer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `RewardOfferMerchant` ADD CONSTRAINT `RewardOfferMerchant_offerId_fkey`
  FOREIGN KEY (`offerId`) REFERENCES `RewardOffer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CardOfferRecord` ADD CONSTRAINT `CardOfferRecord_offerId_fkey`
  FOREIGN KEY (`offerId`) REFERENCES `RewardOffer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `CardOfferRecord` ADD CONSTRAINT `CardOfferRecord_cardId_fkey`
  FOREIGN KEY (`cardId`) REFERENCES `Card`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
