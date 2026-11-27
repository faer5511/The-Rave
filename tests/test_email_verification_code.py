import hashlib
import hmac
import secrets
import time
import unittest
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app import account_auth
from app.auth import CSRF_COOKIE
from app.config import settings
from app.models import Base, EmailVerificationToken, User, UserRole, utcnow
from app.services import ApiError


class EmailVerificationCodeTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://")
        Base.metadata.create_all(self.engine)
        self.session = Session(self.engine, expire_on_commit=False)

        payload = "%d.%s" % (int(time.time()) + 3600, secrets.token_urlsafe(24))
        signature = hmac.new(
            settings.secret_key.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()
        csrf = payload + "." + signature
        self.request = SimpleNamespace(
            cookies={CSRF_COOKIE: csrf},
            headers={"x-csrf-token": csrf},
            client=SimpleNamespace(host="127.0.0.1"),
            url=SimpleNamespace(path="/api/auth/verify-email/code"),
        )

    def tearDown(self):
        self.session.close()
        self.engine.dispose()

    def verify_code(self, body):
        with Session(self.engine, expire_on_commit=False) as session:
            return account_auth.verify_email_code(body, self.request, session)

    def test_registration_sends_a_hashed_six_digit_code(self):
        body = account_auth.RegisterIn(
            login="new-member",
            email="new-member@example.com",
            name="New Member",
            password="SecurePass123",
            password2="SecurePass123",
        )
        with patch("app.account_auth.require_smtp_configured"), patch(
            "app.account_auth.deliver_verification"
        ) as deliver:
            account_auth.register(body, self.request, self.session)

        code = deliver.call_args.args[2]
        self.assertRegex(code, r"^\d{6}$")
        user = self.session.scalar(select(User).where(User.email == body.email))
        record = self.session.scalar(
            select(EmailVerificationToken).where(
                EmailVerificationToken.user_id == user.id
            )
        )
        self.assertEqual(
            record.token_hash, account_auth.verification_code_hash(user.id, code)
        )
        self.assertNotEqual(record.token_hash, code)
        plain_email = account_auth.build_verification_email(user.name, code).get_body(
            preferencelist=("plain",)
        )
        self.assertIn(code, plain_email.get_content())
        self.assertNotIn("/verify-email?", plain_email.get_content())

    def test_resend_without_an_account_explains_registration_is_required(self):
        body = account_auth.ResendIn(email="new-member@example.com")
        with patch("app.account_auth.require_smtp_configured"), patch(
            "app.account_auth.deliver_verification"
        ) as deliver:
            response = account_auth.resend(body, self.request, self.session)

        self.assertIn("сначала зарегистрируйтесь", response["message"])
        deliver.assert_not_called()

    def test_registration_surfaces_mail_delivery_failure(self):
        body = account_auth.RegisterIn(
            login="mail-failure",
            email="mail-failure@example.com",
            name="Mail Failure",
            password="SecurePass123",
            password2="SecurePass123",
        )
        with patch("app.account_auth.require_smtp_configured"), patch(
            "app.account_auth.deliver_verification",
            side_effect=ApiError(
                502, "email_delivery_failed", "Не удалось отправить письмо."
            ),
        ):
            with self.assertRaises(ApiError) as failure:
                account_auth.register(body, self.request, self.session)

        self.assertEqual(failure.exception.code, "email_delivery_failed")
        user = self.session.scalar(select(User).where(User.email == body.email))
        self.assertIsNotNone(user)
        self.assertFalse(user.email_verified)

    def test_code_is_single_use_and_expired_codes_are_rejected(self):
        user = User(
            login="verified-member",
            email="verified@example.com",
            name="Verified Member",
            password_hash=account_auth.password_hash("SecurePass123"),
            role=UserRole.user,
        )
        self.session.add(user)
        self.session.flush()
        code = "012345"
        record = EmailVerificationToken(
            user_id=user.id,
            token_hash=account_auth.verification_code_hash(user.id, code),
            expires_at=utcnow() + timedelta(minutes=10),
        )
        self.session.add(record)
        expired_user = User(
            login="expired-member",
            email="expired@example.com",
            name="Expired Member",
            password_hash=account_auth.password_hash("SecurePass456"),
            role=UserRole.user,
        )
        self.session.add(expired_user)
        self.session.flush()
        expired_code = "654321"
        self.session.add(
            EmailVerificationToken(
                user_id=expired_user.id,
                token_hash=account_auth.verification_code_hash(
                    expired_user.id, expired_code
                ),
                expires_at=utcnow() - timedelta(seconds=1),
            )
        )
        self.session.commit()

        with self.assertRaises(ApiError) as wrong_code:
            self.verify_code(
                account_auth.VerifyCodeIn(email=user.email, code="999999"),
            )
        self.assertEqual(wrong_code.exception.code, "bad_code")

        result = self.verify_code(
            account_auth.VerifyCodeIn(email=user.email, code=code),
        )
        self.assertTrue(result["ok"])
        self.session.expire_all()
        self.assertTrue(self.session.get(User, user.id).email_verified)
        self.session.expire_all()
        self.assertIsNotNone(
            self.session.get(EmailVerificationToken, record.id).used_at
        )

        with self.assertRaises(ApiError) as expired:
            self.verify_code(
                account_auth.VerifyCodeIn(email=expired_user.email, code=expired_code),
            )
        self.assertEqual(expired.exception.code, "expired_code")


if __name__ == "__main__":
    unittest.main()
