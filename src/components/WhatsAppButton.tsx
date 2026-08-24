/* ------------------------------------------------------------------ */
/*  Floating WhatsApp button — opens the WhatsApp web/app chat with    */
/*  the support number when clicked.                                   */
/* ------------------------------------------------------------------ */
interface WhatsAppButtonProps {
  phoneNumber?: string;
}

const DEFAULT_PHONE = "447951579147";

export const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 32 32"
    fill="currentColor"
    className={className}
    aria-hidden="true"
  >
    <path d="M19.11 17.205c-.372 0-1.088 1.39-1.518 1.39a.63.63 0 0 1-.315-.1c-.802-.402-1.504-.817-2.163-1.447-.545-.516-1.146-1.29-1.46-1.963a.426.426 0 0 1-.073-.215c0-.33.99-.945.99-1.49 0-.143-.73-2.09-.832-2.335-.143-.372-.214-.487-.6-.487-.187 0-.36-.043-.53-.043-.302 0-.53.115-.746.315-.688.645-1.032 1.318-1.06 2.264v.114c-.015.99.472 1.977 1.017 2.78 1.23 1.82 2.506 3.41 4.554 4.34.616.287 2.035.888 2.722.888.817 0 2.15-.515 2.478-1.318.13-.33.244-.73.244-1.088 0-.058 0-.144-.03-.215-.1-.172-2.434-1.39-2.678-1.39zm-2.908 7.593c-1.747 0-3.48-.53-4.942-1.49L7.448 24.49l.887-2.988c-.978-1.414-1.502-3.04-1.502-4.732 0-4.577 3.726-8.303 8.308-8.303 4.58 0 8.302 3.726 8.302 8.303 0 4.58-3.726 8.307-8.31 8.307zm8.24-16.606a9.02 9.02 0 0 0-6.402-2.65c-5.086 0-9.22 4.133-9.22 9.22 0 1.92.6 3.76 1.713 5.287l-1.827 6.135 6.32-1.767a9.19 9.19 0 0 0 5.02 1.42c5.09 0 9.22-4.136 9.22-9.22 0-2.46-.96-4.776-2.7-6.516z" />
  </svg>
);

const WhatsAppButton = ({ phoneNumber = DEFAULT_PHONE }: WhatsAppButtonProps) => {
  const href = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(
    "Hello! I'm interested in learning more about your emergency alert system."
  )}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      title="Chat with us on WhatsApp"
      className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition-transform duration-200 hover:scale-110 hover:shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#25D366] focus-visible:ring-offset-2"
    >
      <WhatsAppIcon className="h-7 w-7" />
    </a>
  );
};

export default WhatsAppButton;