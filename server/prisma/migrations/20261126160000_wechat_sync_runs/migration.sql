CREATE TABLE `WechatSyncRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `source` VARCHAR(12) NOT NULL,
    `accountName` VARCHAR(120) NULL,
    `trigger` VARCHAR(12) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `report` JSON NOT NULL,

    INDEX `WechatSyncRun_source_id_idx`(`source`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
