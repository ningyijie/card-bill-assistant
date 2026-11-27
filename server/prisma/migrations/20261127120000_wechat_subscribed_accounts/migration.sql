CREATE TABLE `WechatSubscribedAccount` (
    `sourceId` INTEGER NOT NULL,
    `accountId` VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `syncHours` INTEGER NOT NULL DEFAULT 24,
    `lastAttempt` DATETIME(3) NULL,
    `lastSuccess` DATETIME(3) NULL,
    `error` VARCHAR(255) NULL,
    PRIMARY KEY (`sourceId`, `accountId`),
    CONSTRAINT `WechatSubscribedAccount_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `WechatOfferSubscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `WechatSubscribedAccount` (`sourceId`, `accountId`, `name`, `enabled`, `syncHours`, `lastAttempt`, `lastSuccess`, `error`)
SELECT s.`id`, s.`accountId`, COALESCE(NULLIF(s.`accountName`, ''), s.`accountId`), s.`enabled`,
    CASE WHEN s.`id` = 2 AND settings.`value` IN ('1', '3', '6', '12', '24')
         THEN CAST(settings.`value` AS UNSIGNED) ELSE 24 END,
    s.`lastAttempt`, s.`lastSuccess`, s.`error`
FROM `WechatOfferSubscription` s
LEFT JOIN `AppSetting` settings ON settings.`key` = 'weread_sync_hours'
WHERE s.`id` IN (1, 2) AND s.`accountId` IS NOT NULL AND s.`accountId` <> '';

ALTER TABLE `WechatSyncRun` ADD COLUMN `accountId` VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL;
CREATE INDEX `WechatSyncRun_source_accountId_id_idx` ON `WechatSyncRun`(`source`, `accountId`, `id`);
