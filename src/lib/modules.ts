export type PluginModule = {
  id: string;
  name: string;
  english: string;
  description: string;
  path: string;
  dependencies: string[];
  provides: string[];
  hooks: string[];
  files: string[];
  required?: boolean;
};

export const PLUGIN_MODULES: PluginModule[] = [
  {
    id: "core",
    name: "هسته و چرخه حیات",
    english: "Core & Bootstrap",
    description: "بارگذار ماژول‌ها، تزریق وابستگی، جداول اختصاصی، نسخه دیتابیس و فعال‌سازی امن افزونه.",
    path: "emzagar/src/Core",
    dependencies: [],
    provides: ["Container", "Activator", "MigrationRunner", "ModuleManager"],
    hooks: ["plugins_loaded", "register_activation_hook", "init"],
    files: ["Plugin.php", "Container.php", "Activator.php", "Database/Migrator.php"],
    required: true,
  },
  {
    id: "templates",
    name: "قالب و متغیرها",
    english: "Templates & Tokens",
    description: "نسخه‌بندی قالب، ویرایش متن، ثبت متغیرهای مجاز و جایگزینی امن داده کاربر و سفارش.",
    path: "emzagar/src/Templates",
    dependencies: ["core"],
    provides: ["TemplateRepository", "TokenParser", "TemplateRenderer"],
    hooks: ["emzagar/register_tokens", "emzagar/template_saved"],
    files: ["TemplateService.php", "TokenParser.php", "Tokens/UserTokens.php", "Tokens/OrderTokens.php"],
  },
  {
    id: "workflow",
    name: "صدور و گردش‌کار",
    english: "Contract Workflow",
    description: "صدور از قالب، Snapshot محتوا، صف امضاکنندگان، انقضا، لغو و کنترل گذارهای وضعیت.",
    path: "emzagar/src/Contracts",
    dependencies: ["core", "templates"],
    provides: ["ContractRepository", "StateMachine", "SignerQueue"],
    hooks: ["emzagar/contract_issued", "emzagar/signer_advanced", "emzagar/contract_completed"],
    files: ["ContractService.php", "StateMachine.php", "IssueContractCommand.php", "Policy.php"],
  },
  {
    id: "identity",
    name: "احراز هویت OTP",
    english: "Identity & OTP",
    description: "کد یکبارمصرف هش‌شده، انقضا، محدودیت تلاش و ارسال مجدد؛ جدا از درگاه پیامک.",
    path: "emzagar/src/Identity",
    dependencies: ["core"],
    provides: ["OtpService", "RateLimiter", "VerificationSession"],
    hooks: ["emzagar/otp_created", "emzagar/identity_verified"],
    files: ["OtpService.php", "CodeHasher.php", "Throttle.php", "SessionToken.php"],
  },
  {
    id: "signature",
    name: "بوم و ثبت امضا",
    english: "Signature Capture",
    description: "ترسیم لمسی، آپلود امن تصویر، رضایت صریح، اعتبارسنجی Base64 و ثبت اثر انگشت سند.",
    path: "emzagar/src/Signature",
    dependencies: ["core", "workflow", "identity"],
    provides: ["SignatureValidator", "SigningService", "EvidenceBuilder"],
    hooks: ["emzagar/before_signature", "emzagar/signature_recorded"],
    files: ["SignatureService.php", "ImageValidator.php", "Evidence.php", "RestController.php"],
  },
  {
    id: "pdf",
    name: "سند و خروجی PDF",
    english: "Document & PDF",
    description: "رندر HTML با فونت فارسی، درج امضاها، شناسنامه دیجیتال و ذخیره بیرون از ریشه عمومی.",
    path: "emzagar/src/Documents",
    dependencies: ["core", "workflow", "signature"],
    provides: ["PdfRenderer", "PrivateStorage", "DocumentHasher"],
    hooks: ["emzagar/pdf_rendered", "emzagar/document_stored"],
    files: ["PdfService.php", "MpdfRenderer.php", "PrivateStorage.php", "DownloadController.php"],
  },
  {
    id: "notifications",
    name: "اطلاع‌رسانی و درگاه‌ها",
    english: "Notifications & Gateways",
    description: "صف اطلاع‌رسانی، ایمیل با پیوست و آداپتورهای کاوه‌نگار و سایر پنل‌های ایرانی.",
    path: "emzagar/src/Notifications",
    dependencies: ["core"],
    provides: ["Notifier", "SmsManager", "Mailer", "RetryQueue"],
    hooks: ["emzagar/register_sms_gateways", "emzagar/notification_sent"],
    files: ["NotificationService.php", "Gateways/Kavenegar.php", "Gateways/DemoGateway.php", "Jobs/Retry.php"],
  },
  {
    id: "woocommerce",
    name: "یکپارچگی ووکامرس",
    english: "WooCommerce Bridge",
    description: "نگاشت محصول به قالب، صدور پس از سفارش و جلوگیری از صدور تکراری با Idempotency Key.",
    path: "emzagar/src/Integrations/WooCommerce",
    dependencies: ["core", "workflow"],
    provides: ["OrderListener", "ProductTemplateMap", "AccountEndpoint"],
    hooks: ["woocommerce_order_status_processing", "woocommerce_account_contracts_endpoint"],
    files: ["WooCommerceModule.php", "OrderSubscriber.php", "ProductMapping.php", "MyAccount.php"],
  },
  {
    id: "audit",
    name: "حسابرسی و امنیت",
    english: "Audit & Security",
    description: "رویدادهای تغییرناپذیر، IP و User-Agent، Nonce، Capability و جداسازی دسترسی کاربران.",
    path: "emzagar/src/Security",
    dependencies: ["core"],
    provides: ["AuditLogger", "AccessControl", "NonceGuard", "RequestContext"],
    hooks: ["emzagar/audit_event", "emzagar/access_denied"],
    files: ["AuditLogger.php", "Capabilities.php", "RequestContext.php", "Sanitizer.php"],
    required: true,
  },
];

export const PLUGIN_FILE_TREE = `emzagar/
├── emzagar.php                 # bootstrap + autoload
├── uninstall.php               # حذف آگاهانه داده‌ها
├── src/
│   ├── Core/                   # container, migrations, lifecycle
│   ├── Templates/              # tokens + versioning
│   ├── Contracts/              # state machine + signer queue
│   ├── Identity/               # OTP + throttling
│   ├── Signature/              # draw/upload + evidence
│   ├── Documents/              # PDF + private storage
│   ├── Notifications/          # mail + SMS adapters
│   ├── Integrations/
│   │   └── WooCommerce/        # order bridge + account tab
│   └── Security/               # policies + audit trail
├── admin/                      # React UI یا صفحات مدیریت
├── public/                     # shortcode + signing screen
├── assets/                     # signature-pad.js, app.css
├── templates/                  # pdf, email, dashboard views
└── tests/                      # unit + workflow integration`;

export function buildArchitectureMarkdown(enabled: string[] = PLUGIN_MODULES.map((m) => m.id)) {
  const rows = PLUGIN_MODULES.map((module) => {
    const state = enabled.includes(module.id) ? "فعال" : "غیرفعال";
    return `### ${module.name} — ${state}\n- مسیر: \`${module.path}\`\n- وابستگی‌ها: ${module.dependencies.join(", ") || "ندارد"}\n- خدمات: ${module.provides.join(", ")}\n- هوک‌ها: ${module.hooks.map((h) => `\`${h}\``).join(", ")}\n- فایل‌ها: ${module.files.map((f) => `\`${f}\``).join(", ")}`;
  }).join("\n\n");
  return `# معماری ماژولار افزونه امضاگیر\n\nاین سند از رجیستری ماژول‌های میزکار تولید شده است.\n\n## اصول\n1. هر ماژول فقط از طریق Service Container با ماژول دیگر ارتباط دارد.\n2. متن قالب هنگام صدور Snapshot می‌شود؛ ویرایش قالب، قرارداد قبلی را تغییر نمی‌دهد.\n3. کنترلرها منطق تجاری ندارند و تمام گذارهای وضعیت از StateMachine عبور می‌کنند.\n4. ذخیره فایل، ارسال پیامک و تولید PDF پشت Interface قرار دارند.\n\n${rows}\n\n## ساختار پیشنهادی\n\`\`\`\n${PLUGIN_FILE_TREE}\n\`\`\`\n`;
}
