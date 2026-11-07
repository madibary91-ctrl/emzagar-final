export const SERVICE_BODY = `
<h2 style="text-align:center">قرارداد ارائه خدمات</h2>
<p>شماره قرارداد: <strong>[CONTRACT_NUMBER]</strong> &nbsp;&nbsp; تاریخ: <strong>[DATE]</strong></p>
<p>این قرارداد میان <strong>[SITE_NAME]</strong> (به‌عنوان «ارائه‌دهنده») و <strong>[USER_NAME]</strong> با ایمیل [USER_EMAIL] و شماره تماس [USER_MOBILE] (به‌عنوان «مشتری») منعقد می‌شود.</p>
<h3>ماده ۱ — موضوع قرارداد</h3>
<p>موضوع قرارداد عبارت است از ارائه‌ی خدمت «[PRODUCT_NAME]» به مبلغ [AMOUNT] تومان.</p>
<h3>ماده ۲ — تعهدات ارائه‌دهنده</h3>
<ul><li>ارائه‌ی خدمت مطابق مشخصات توافق‌شده و در زمان مقرر</li><li>حفظ محرمانگی اطلاعات مشتری</li></ul>
<h3>ماده ۳ — تعهدات مشتری</h3>
<ul><li>پرداخت به‌موقع مبلغ قرارداد</li><li>ارائه‌ی اطلاعات صحیح و کامل</li></ul>
<h3>ماده ۴ — حل اختلاف</h3>
<p>در صورت بروز اختلاف، موضوع ابتدا از طریق مذاکره و در صورت عدم توافق از طریق مراجع قضایی صالح پیگیری می‌شود.</p>
`;

export const NDA_BODY = `
<h2 style="text-align:center">تعهدنامه محرمانگی (NDA)</h2>
<p>شماره: <strong>[CONTRACT_NUMBER]</strong> — تاریخ: <strong>[DATE]</strong></p>
<p>اینجانب <strong>[USER_NAME]</strong> متعهد می‌شوم کلیه‌ی اطلاعات فنی، مالی و تجاری که در جریان همکاری با <strong>[SITE_NAME]</strong> در اختیارم قرار می‌گیرد را محرمانه نگه دارم و بدون اجازه‌ی کتبی به هیچ شخص ثالثی افشا نکنم.</p>
<p>این تعهد پس از پایان همکاری نیز به مدت دو سال معتبر است.</p>
`;


export const STARTER_TEMPLATES = [
  { title: "قرارداد ارائه خدمات", description: "قالب عمومی ارائه‌ی خدمات به مشتری", body: SERVICE_BODY },
  { title: "تعهدنامه محرمانگی", description: "NDA برای همکاران و پیمانکاران", body: NDA_BODY },
];
